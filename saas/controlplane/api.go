package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var (
	namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`)
	idPattern   = regexp.MustCompile(`^db_[a-z2-7]{24}$`)
)

type api struct {
	store       store
	provisioner provisioner
	adminKey    string
	now         func() time.Time
}

type databaseResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Tier      string `json:"tier"`
	State     string `json:"state"`
	Endpoint  string `json:"endpoint"`
	Token     string `json:"token,omitempty"`
	CreatedAt string `json:"created_at"`
	Error     string `json:"error,omitempty"`
}

type createDatabaseRequest struct {
	Name string `json:"name"`
	Tier string `json:"tier"`
}

func newAPI(store store, provisioner provisioner, adminKey string) *api {
	return &api{store: store, provisioner: provisioner, adminKey: adminKey, now: func() time.Time { return time.Now().UTC() }}
}

func (a *api) register(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/databases", a.withCORS(a.handleDatabases))
	mux.HandleFunc("/api/v1/databases/", a.withCORS(a.handleDatabase))
}

func (a *api) handleDatabases(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
	case http.MethodPost:
		a.createDatabase(w, r)
	case http.MethodGet:
		a.listDatabases(w, r)
	default:
		writeError(w, http.StatusNotFound, "not_found", "route not found", "")
	}
}

func (a *api) handleDatabase(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/databases/")
	if strings.Contains(id, "/") || !idPattern.MatchString(id) {
		writeError(w, http.StatusNotFound, "not_found", "database not found", "")
		return
	}

	switch r.Method {
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
	case http.MethodGet:
		a.getDatabase(w, r, id)
	case http.MethodDelete:
		a.deleteDatabase(w, r, id)
	default:
		writeError(w, http.StatusNotFound, "not_found", "route not found", "")
	}
}

func (a *api) createDatabase(w http.ResponseWriter, r *http.Request) {
	if !a.authorized(w, r) {
		return
	}
	defer r.Body.Close()

	var req createDatabaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body", err.Error())
		return
	}
	if !validName(req.Name) {
		writeError(w, http.StatusBadRequest, "invalid_request", "name must match ^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$", "")
		return
	}
	spec, ok := tierSpecs[req.Tier]
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_request", "tier must be one of free, standard, premium", "")
		return
	}

	instances, err := a.store.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "list metadata", err.Error())
		return
	}
	count := 0
	for _, in := range instances {
		if in.Tier == req.Tier {
			count++
		}
	}
	if count >= spec.Quota {
		writeError(w, http.StatusTooManyRequests, "quota_exceeded", "tier instance quota exceeded", "")
		return
	}

	id, err := generateInstanceID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "generate instance id", err.Error())
		return
	}
	token, err := generateAccessToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "generate access token", err.Error())
		return
	}

	in := instance{
		ID:               id,
		Name:             req.Name,
		Tier:             req.Tier,
		TokenHash:        tokenHash(token),
		CreatedAt:        a.now(),
		ContainerAppName: containerAppName(id),
	}

	endpoint, err := a.provisioner.Create(r.Context(), in, token)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "create container app", err.Error())
		return
	}
	if err := a.store.Save(r.Context(), in); err != nil {
		_ = a.provisioner.Delete(context.Background(), in)
		writeError(w, http.StatusInternalServerError, "internal", "save metadata", err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, databaseResponse{
		ID:        in.ID,
		Name:      in.Name,
		Tier:      in.Tier,
		State:     "provisioning",
		Endpoint:  endpoint,
		Token:     token,
		CreatedAt: in.CreatedAt.Format(time.RFC3339),
	})
}

func (a *api) listDatabases(w http.ResponseWriter, r *http.Request) {
	instances, err := a.store.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "list metadata", err.Error())
		return
	}
	responses := make([]databaseResponse, 0, len(instances))
	for _, in := range instances {
		responses = append(responses, a.responseFor(r.Context(), in))
	}
	writeJSON(w, http.StatusOK, map[string][]databaseResponse{"databases": responses})
}

func (a *api) getDatabase(w http.ResponseWriter, r *http.Request, id string) {
	in, err := a.store.Get(r.Context(), id)
	if errors.Is(err, errNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "database not found", "")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "read metadata", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, a.responseFor(r.Context(), in))
}

func (a *api) deleteDatabase(w http.ResponseWriter, r *http.Request, id string) {
	if !a.authorized(w, r) {
		return
	}
	in, err := a.store.Get(r.Context(), id)
	if err == nil {
		if err := a.provisioner.Delete(r.Context(), in); err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "delete container app", err.Error())
			return
		}
		_ = a.store.Delete(r.Context(), id)
	} else if !errors.Is(err, errNotFound) {
		writeError(w, http.StatusInternalServerError, "internal", "read metadata", err.Error())
		return
	} else {
		in = instance{ID: id, ContainerAppName: containerAppName(id)}
		if err := a.provisioner.Delete(r.Context(), in); err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "delete container app", err.Error())
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) responseFor(ctx context.Context, in instance) databaseResponse {
	state, err := a.provisioner.GetState(ctx, in)
	if err != nil {
		state = liveState{State: "failed", Error: err.Error()}
	}
	return databaseResponse{
		ID:        in.ID,
		Name:      in.Name,
		Tier:      in.Tier,
		State:     state.State,
		Endpoint:  a.provisioner.Endpoint(in),
		CreatedAt: in.CreatedAt.Format(time.RFC3339),
		Error:     state.Error,
	}
}

func (a *api) authorized(w http.ResponseWriter, r *http.Request) bool {
	if a.adminKey == "" || r.Header.Get("X-Admin-Key") == a.adminKey {
		return true
	}
	writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid admin key", "")
	return false
}

func (a *api) withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		methods := "GET, OPTIONS"
		if origin == "" {
			if r.Method == http.MethodGet || r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Origin", "*")
			}
		} else if r.Method == http.MethodGet || r.Method == http.MethodOptions || sameOrigin(origin, r.Host) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			if sameOrigin(origin, r.Host) {
				methods = "GET, OPTIONS, POST, DELETE"
			}
		}
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Methods", methods)
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key")
		next(w, r)
	}
}

func sameOrigin(origin, host string) bool {
	u, err := url.Parse(origin)
	return err == nil && u.Host == host
}

func validName(name string) bool {
	return namePattern.MatchString(name)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message, detail string) {
	body := map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	}
	if detail != "" {
		body["error"].(map[string]string)["detail"] = detail
	}
	writeJSON(w, status, body)
}
