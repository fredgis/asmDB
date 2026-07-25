package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
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
	cfg         config
	verifier    accessTokenVerifier
	httpClient  *http.Client
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

type execRequest struct {
	Command string `json:"command"`
}

type execResponse struct {
	Output []string `json:"output"`
	OK     bool     `json:"ok"`
}

func newAPI(store store, provisioner provisioner, cfg config, verifier accessTokenVerifier) *api {
	return &api{
		store:       store,
		provisioner: provisioner,
		cfg:         cfg,
		verifier:    verifier,
		httpClient:  &http.Client{Timeout: 60 * time.Second},
		now:         func() time.Time { return time.Now().UTC() },
	}
}

func (a *api) register(mux *http.ServeMux) {
	mux.HandleFunc("/healthz", handleHealthz)
	mux.HandleFunc("/api/v1/config", a.withCORS(a.handleConfig))
	mux.HandleFunc("/api/v1/databases", a.withCORS(a.handleDatabases))
	mux.HandleFunc("/api/v1/databases/", a.withCORS(a.handleDatabase))
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusNotFound, "not_found", "route not found", "")
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}

func (a *api) handleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusNotFound, "not_found", "route not found", "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"tenantId": a.cfg.EntraTenantID,
		"clientId": a.cfg.EntraClientID,
		"scope":    a.cfg.EntraScope,
	})
}

func (a *api) handleDatabases(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
	case http.MethodPost:
		if !a.authorized(w, r) {
			return
		}
		a.createDatabase(w, r)
	case http.MethodGet:
		if !a.authorized(w, r) {
			return
		}
		a.listDatabases(w, r)
	default:
		writeError(w, http.StatusNotFound, "not_found", "route not found", "")
	}
}

func (a *api) handleDatabase(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/databases/")
	parts := strings.Split(rest, "/")
	if len(parts) == 2 && parts[1] == "exec" {
		a.handleExec(w, r, parts[0])
		return
	}
	if len(parts) != 1 || !idPattern.MatchString(parts[0]) {
		writeError(w, http.StatusNotFound, "not_found", "database not found", "")
		return
	}
	id := parts[0]

	switch r.Method {
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
	case http.MethodGet:
		if !a.authorized(w, r) {
			return
		}
		a.getDatabase(w, r, id)
	case http.MethodDelete:
		if !a.authorized(w, r) {
			return
		}
		a.deleteDatabase(w, r, id)
	default:
		writeError(w, http.StatusNotFound, "not_found", "route not found", "")
	}
}

func (a *api) createDatabase(w http.ResponseWriter, r *http.Request) {
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

func (a *api) handleExec(w http.ResponseWriter, r *http.Request, id string) {
	if !idPattern.MatchString(id) {
		writeError(w, http.StatusNotFound, "not_found", "database not found", "")
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusNotFound, "not_found", "route not found", "")
		return
	}
	defer r.Body.Close()

	token, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token", "")
		return
	}

	in, err := a.store.Get(r.Context(), id)
	if errors.Is(err, errNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "database not found", "")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "read metadata", err.Error())
		return
	}
	if subtle.ConstantTimeCompare([]byte(tokenHash(token)), []byte(in.TokenHash)) != 1 {
		writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token", "")
		return
	}

	var req execRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body", err.Error())
		return
	}
	body, err := json.Marshal(req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "marshal exec request", err.Error())
		return
	}

	upstreamURL := strings.TrimRight(a.provisioner.Endpoint(in), "/") + "/v1/exec"
	upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, upstreamURL, bytes.NewReader(body))
	if err != nil {
		writeError(w, http.StatusBadGateway, "bad_gateway", "instance unreachable", err.Error())
		return
	}
	upstreamReq.Header.Set("Authorization", "Bearer "+token)
	upstreamReq.Header.Set("Content-Type", "application/json")

	resp, err := a.httpClient.Do(upstreamReq)
	if err != nil {
		if isTimeoutError(err) {
			writeError(w, http.StatusGatewayTimeout, "gateway_timeout", "instance timed out", "")
			return
		}
		writeError(w, http.StatusBadGateway, "bad_gateway", "instance unreachable", err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		writeError(w, http.StatusBadGateway, "bad_gateway", "instance returned an error", resp.Status)
		return
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		writeError(w, http.StatusBadGateway, "bad_gateway", "read instance response", err.Error())
		return
	}
	var out execResponse
	if err := json.Unmarshal(data, &out); err != nil {
		writeError(w, http.StatusBadGateway, "bad_gateway", "instance returned invalid JSON", err.Error())
		return
	}
	if out.Output == nil {
		writeError(w, http.StatusBadGateway, "bad_gateway", "instance returned invalid response", "")
		return
	}
	writeJSON(w, http.StatusOK, out)
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
	token, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok || a.verifier == nil || a.cfg.EntraGroupID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token", "")
		return false
	}
	claims, err := a.verifier.Verify(r.Context(), token)
	if err != nil || !containsString(claims.Scopes, entraScopeName) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token", "")
		return false
	}
	if !containsString(claims.Groups, a.cfg.EntraGroupID) {
		writeError(w, http.StatusForbidden, "forbidden", "required group membership missing", "")
		return false
	}
	return true
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
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		next(w, r)
	}
}

func bearerToken(header string) (string, bool) {
	scheme, token, ok := strings.Cut(strings.TrimSpace(header), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || strings.TrimSpace(token) == "" {
		return "", false
	}
	return strings.TrimSpace(token), true
}

func isTimeoutError(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
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
