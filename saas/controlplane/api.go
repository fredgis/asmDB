package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	statsRequestTimeout  = 2 * time.Second
	statsListTimeout     = 3 * time.Second
	healthCheckTimeout   = 3 * time.Second
	defaultBackupTimeout = 30 * time.Minute
	pendingTokenTTL      = 15 * time.Minute
	maxUpstreamBodyBytes = 4 << 20
	operationStaleAfter  = 30 * time.Minute
	execColdStartBudget  = 45 * time.Second
	execColdStartBackoff = 2 * time.Second
	wakeRequestTimeout   = 2 * time.Second
	costMaxWindow        = 31 * 24 * time.Hour
	costMetricGrain      = 15 * time.Minute
)

var (
	namePattern       = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`)
	idPattern         = regexp.MustCompile(`^db_[a-z2-7]{24}$`)
	versionTagPattern = regexp.MustCompile(`^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$`)
)

type api struct {
	store            store
	provisioner      provisioner
	cfg              config
	verifier         accessTokenVerifier
	httpClient       *http.Client
	statsClient      *http.Client
	wakeClient       *http.Client
	execRetryBudget  time.Duration
	execRetryBackoff time.Duration
	backupTimeout    time.Duration
	now              func() time.Time
}

type databaseResponse struct {
	ID               string             `json:"id"`
	Name             string             `json:"name"`
	Tier             string             `json:"tier"`
	Image            string             `json:"image,omitempty"`
	Engine           string             `json:"engine,omitempty"`
	State            string             `json:"state"`
	Endpoint         string             `json:"endpoint"`
	Token            string             `json:"token,omitempty"`
	CreatedAt        string             `json:"created_at"`
	Error            string             `json:"error,omitempty"`
	Stats            *statsResponse     `json:"stats,omitempty"`
	StorageFormat    string             `json:"storageFormat,omitempty"`
	EngineSource     string             `json:"engineSource,omitempty"`
	Operation        *operationResponse `json:"operation,omitempty"`
	UpgradeAvailable bool               `json:"upgradeAvailable"`
	AvailableEngine  string             `json:"availableEngine,omitempty"`
	AvailableImage   string             `json:"availableImage,omitempty"`
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

type rotateTokenResponse struct {
	Token   string `json:"token"`
	Warning string `json:"warning"`
}

type statsResponse struct {
	Available bool            `json:"available"`
	Reason    string          `json:"reason,omitempty"`
	Stats     json.RawMessage `json:"stats,omitempty"`
}

type healthResponse struct {
	Status        string `json:"status"`
	Engine        string `json:"engine"`
	StorageFormat string `json:"storageFormat"`
	Rows          int64  `json:"rows"`
}

type prepareUpgradeResponse struct {
	OK     bool            `json:"ok"`
	Backup json.RawMessage `json:"backup,omitempty"`
	Detail string          `json:"detail,omitempty"`
}

type operationResponse struct {
	Type      string    `json:"type"`
	State     string    `json:"state"`
	StartedAt time.Time `json:"started_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Error     string    `json:"error,omitempty"`
}

type versionResponse struct {
	Engine string `json:"engine,omitempty"`
	Image  string `json:"image,omitempty"`
}

func newAPI(store store, provisioner provisioner, cfg config, verifier accessTokenVerifier) *api {
	return &api{
		store:            store,
		provisioner:      provisioner,
		cfg:              cfg,
		verifier:         verifier,
		httpClient:       &http.Client{Timeout: 60 * time.Second},
		statsClient:      &http.Client{Timeout: statsRequestTimeout},
		wakeClient:       &http.Client{Timeout: wakeRequestTimeout},
		execRetryBudget:  execColdStartBudget,
		execRetryBackoff: execColdStartBackoff,
		backupTimeout:    backupTimeoutOrDefault(cfg.BackupTimeout),
		now:              func() time.Time { return time.Now().UTC() },
	}
}

func (a *api) register(mux *http.ServeMux) {
	mux.HandleFunc("/healthz", handleHealthz)
	mux.HandleFunc("/api/v1/version", a.withCORS(a.handleVersion))
	mux.HandleFunc("/api/v1/config", a.withCORS(a.handleConfig))
	mux.HandleFunc("/api/v1/costs", a.withCORS(a.handleCosts))
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

func (a *api) handleVersion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusNotFound, "not_found", "route not found", "")
		return
	}
	writeJSON(w, http.StatusOK, versionResponse{
		Engine: a.availableEngine(),
		Image:  a.cfg.Image,
	})
}

func (a *api) handleDatabases(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
	case http.MethodPost:
		actor, ok := a.authorizedActor(w, r)
		if !ok {
			return
		}
		a.createDatabase(w, r, actor)
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
	if len(parts) == 2 && parts[1] == "rotate-token" {
		a.handleRotateToken(w, r, parts[0])
		return
	}
	if len(parts) == 3 && parts[1] == "rotate-token" && parts[2] == "commit" {
		a.handleRotateTokenCommit(w, r, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "stats" {
		a.handleStats(w, r, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "upgrade" {
		a.handleUpgrade(w, r, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "wake" {
		a.handleWake(w, r, parts[0])
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
		actor, ok := a.authorizedActor(w, r)
		if !ok {
			return
		}
		a.deleteDatabase(w, r, id, actor)
	default:
		writeError(w, http.StatusNotFound, "not_found", "route not found", "")
	}
}

func (a *api) createDatabase(w http.ResponseWriter, r *http.Request, actor string) {
	defer r.Body.Close()

	var req createDatabaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body", internalDetail(err))
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
		writeError(w, http.StatusInternalServerError, "internal", "list metadata", internalDetail(err))
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
		writeError(w, http.StatusInternalServerError, "internal", "generate instance id", internalDetail(err))
		return
	}
	token, err := generateAccessToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "generate access token", internalDetail(err))
		return
	}

	in := instance{
		ID:               id,
		Name:             req.Name,
		Tier:             req.Tier,
		Image:            a.cfg.Image,
		Engine:           engineFromImage(a.cfg.Image),
		EngineSource:     "image",
		TokenHash:        tokenHash(token),
		CreatedAt:        a.now(),
		ContainerAppName: containerAppName(id),
	}

	endpoint, err := a.provisioner.Create(r.Context(), in, token)
	if err != nil {
		a.audit(actor, "create", in.ID, "failed")
		writeError(w, http.StatusInternalServerError, "internal", "create container app", internalDetail(err))
		return
	}
	if err := a.store.Save(r.Context(), in); err != nil {
		_ = a.provisioner.Delete(context.Background(), in)
		writeError(w, http.StatusInternalServerError, "internal", "save metadata", internalDetail(err))
		return
	}

	a.audit(actor, "create", in.ID, "ok")
	writeJSON(w, http.StatusCreated, databaseResponse{
		ID:        in.ID,
		Name:      in.Name,
		Tier:      in.Tier,
		Image:     in.Image,
		Engine:    in.Engine,
		State:     "provisioning",
		Endpoint:  endpoint,
		Token:     token,
		CreatedAt: in.CreatedAt.Format(time.RFC3339),
	})
}

func (a *api) listDatabases(w http.ResponseWriter, r *http.Request) {
	instances, err := a.store.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "list metadata", internalDetail(err))
		return
	}
	responses := make([]databaseResponse, 0, len(instances))
	for _, in := range instances {
		responses = append(responses, a.responseFor(r.Context(), in))
	}
	if includeStats(r) {
		stats := a.fetchStatsForList(r.Context(), instances)
		for i, in := range instances {
			got := stats[in.ID]
			responses[i].Stats = &got
		}
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
		writeError(w, http.StatusInternalServerError, "internal", "read metadata", internalDetail(err))
		return
	}
	writeJSON(w, http.StatusOK, a.responseFor(r.Context(), in))
}

func (a *api) deleteDatabase(w http.ResponseWriter, r *http.Request, id string, actor string) {
	in, err := a.store.Get(r.Context(), id)
	if err == nil {
		if err := a.provisioner.Delete(r.Context(), in); err != nil {
			a.audit(actor, "delete", id, "failed")
			writeError(w, http.StatusInternalServerError, "internal", "delete container app", internalDetail(err))
			return
		}
		_ = a.store.Delete(r.Context(), id)
	} else if !errors.Is(err, errNotFound) {
		a.audit(actor, "delete", id, "failed")
		writeError(w, http.StatusInternalServerError, "internal", "read metadata", internalDetail(err))
		return
	} else {
		in = instance{ID: id, ContainerAppName: containerAppName(id)}
		if err := a.provisioner.Delete(r.Context(), in); err != nil {
			a.audit(actor, "delete", id, "failed")
			writeError(w, http.StatusInternalServerError, "internal", "delete container app", internalDetail(err))
			return
		}
	}
	a.audit(actor, "delete", id, "ok")
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) handleRotateToken(w http.ResponseWriter, r *http.Request, id string) {
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
	actor, ok := a.authorizedActor(w, r)
	if !ok {
		return
	}

	in, err := a.store.Get(r.Context(), id)
	if errors.Is(err, errNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "database not found", "")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "read metadata", internalDetail(err))
		return
	}
	in = a.expireStaleOperation(context.Background(), in)
	if operationActive(in.Operation) {
		if in.Operation.Type == "rotate-token" && in.Operation.State == "pending_ack" && in.Operation.PendingTokenEncrypted != "" {
			token, err := decryptRotationToken(a.cfg.PlatformSecret, in.ID, in.Operation.PendingTokenEncrypted)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal", "recover pending token", internalDetail(err))
				return
			}
			writeJSON(w, http.StatusAccepted, map[string]any{
				"operation": operationForResponse(in.Operation),
				"token":     token,
				"warning":   "Token rotation is prepared but not committed. Store this token, then call /rotate-token/commit to apply it.",
			})
			return
		}
		writeError(w, http.StatusConflict, "operation_in_progress", "database operation already in progress", in.Operation.Type+" "+in.Operation.State)
		return
	}

	token, err := generateAccessToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "generate access token", internalDetail(err))
		return
	}
	encrypted, err := encryptRotationToken(a.cfg.PlatformSecret, in.ID, token)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "encrypt pending token", internalDetail(err))
		return
	}

	now := a.now()
	in.Operation = &operation{
		Type:                  "rotate-token",
		State:                 "pending_ack",
		StartedAt:             now,
		UpdatedAt:             now,
		PendingTokenEncrypted: encrypted,
		PendingTokenExpiresAt: now.Add(pendingTokenTTL),
	}
	// Rotation is deliberately two-phase. Preparing stores the new plaintext
	// token only in the direct response; metadata stores an encrypted, short-
	// lived copy so a client that times out can retry prepare and recover it.
	// Only /rotate-token/commit applies the token hash or app secret.
	if err := a.store.Save(context.Background(), in); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "save metadata", internalDetail(err))
		return
	}
	a.audit(actor, "rotate-token-prepare", in.ID, "ok")
	writeJSON(w, http.StatusAccepted, map[string]any{
		"operation": operationForResponse(in.Operation),
		"token":     token,
		"warning":   "Token rotation is prepared but not committed. Store this token, then call /rotate-token/commit to apply it.",
	})
}

func (a *api) handleRotateTokenCommit(w http.ResponseWriter, r *http.Request, id string) {
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
	actor, ok := a.authorizedActor(w, r)
	if !ok {
		return
	}

	in, err := a.store.Get(r.Context(), id)
	if errors.Is(err, errNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "database not found", "")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "read metadata", internalDetail(err))
		return
	}
	in = a.expireStaleOperation(context.Background(), in)
	if in.Operation == nil || in.Operation.Type != "rotate-token" || in.Operation.State != "pending_ack" || in.Operation.PendingTokenEncrypted == "" {
		writeError(w, http.StatusConflict, "invalid_request", "no prepared token rotation to commit", "")
		return
	}
	token, err := decryptRotationToken(a.cfg.PlatformSecret, in.ID, in.Operation.PendingTokenEncrypted)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "recover pending token", internalDetail(err))
		return
	}
	in.Operation.State = "stopping"
	in.Operation.UpdatedAt = a.now()
	if err := a.store.Save(context.Background(), in); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "save metadata", internalDetail(err))
		return
	}
	a.audit(actor, "rotate-token-commit", in.ID, "ok")
	go a.runRotateToken(in, token)
	writeJSON(w, http.StatusAccepted, map[string]any{
		"operation": operationForResponse(in.Operation),
		"token":     token,
		"warning":   "Token rotation is applying asynchronously. Store this token; it will be purged from metadata after completion.",
	})
}

func (a *api) runRotateToken(in instance, token string) {
	progress := func(state string) { a.updateOperationState(context.Background(), in.ID, state, "") }
	if err := a.provisioner.RotateToken(context.Background(), in, token, progress); err != nil {
		a.updateOperationState(context.Background(), in.ID, "failed", "token rotation failed; the previous token may still be active if rollback completed: "+err.Error())
		return
	}
	updated, err := a.store.Get(context.Background(), in.ID)
	if err != nil {
		return
	}
	updated.TokenHash = tokenHash(token)
	updated.Operation = &operation{Type: "rotate-token", State: "done", StartedAt: previousOperationStarted(updated.Operation, a.now()), UpdatedAt: a.now()}
	_ = a.store.Save(context.Background(), updated)
}

func (a *api) handleStats(w http.ResponseWriter, r *http.Request, id string) {
	if !idPattern.MatchString(id) {
		writeError(w, http.StatusNotFound, "not_found", "database not found", "")
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusNotFound, "not_found", "route not found", "")
		return
	}
	if !a.authorized(w, r) {
		return
	}

	in, err := a.store.Get(r.Context(), id)
	if errors.Is(err, errNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "database not found", "")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "read metadata", internalDetail(err))
		return
	}
	writeJSON(w, http.StatusOK, a.fetchStats(r.Context(), in))
}

func (a *api) handleUpgrade(w http.ResponseWriter, r *http.Request, id string) {
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
	actor, ok := a.authorizedActor(w, r)
	if !ok {
		return
	}

	in, err := a.store.Get(r.Context(), id)
	if errors.Is(err, errNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "database not found", "")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "read metadata", internalDetail(err))
		return
	}
	in = a.expireStaleOperation(context.Background(), in)
	if operationActive(in.Operation) {
		writeError(w, http.StatusConflict, "operation_in_progress", "database operation already in progress", in.Operation.Type+" "+in.Operation.State)
		return
	}
	if !a.upgradeAvailable(in) {
		writeError(w, http.StatusConflict, "no_upgrade", "database already uses the current engine image", "")
		return
	}
	if a.cfg.PlatformSecret == "" {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "platform credential is not configured", "")
		return
	}
	now := a.now()
	in.Operation = &operation{Type: "upgrade", State: "preparing_backup", StartedAt: now, UpdatedAt: now}
	if err := a.store.Save(context.Background(), in); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "save metadata", internalDetail(err))
		return
	}
	res := a.responseFor(r.Context(), in)
	a.audit(actor, "upgrade", in.ID, "ok")
	go a.runUpgrade(in)
	writeJSON(w, http.StatusAccepted, map[string]any{
		"database":  res,
		"operation": in.Operation,
		"warning":   "Upgrade runs asynchronously, restarts the instance, and briefly interrupts active connections.",
	})
}

func (a *api) runUpgrade(in instance) {
	ctx := context.Background()
	if err := a.backupInstance(ctx, in); err != nil {
		a.updateOperationState(ctx, in.ID, "failed", "backup failed; upgrade aborted before changing the instance: "+err.Error())
		return
	}
	progress := func(state string) { a.updateOperationState(ctx, in.ID, state, "") }
	if err := a.provisioner.UpgradeImage(ctx, in, a.cfg.Image, progress); err != nil {
		a.updateOperationState(ctx, in.ID, "failed", "replacement did not become healthy; rolled back to the previous version: "+err.Error())
		return
	}
	updated, err := a.store.Get(ctx, in.ID)
	if err != nil {
		return
	}
	updated.Image = a.cfg.Image
	updated.Engine = engineFromImage(updated.Image)
	updated.EngineSource = "image"
	if report, ok := a.refreshEngine(ctx, updated); ok {
		updated = a.applyInstanceReport(ctx, updated, report.Engine, report.StorageFormat)
	}
	updated.Operation = &operation{Type: "upgrade", State: "done", StartedAt: previousOperationStarted(updated.Operation, a.now()), UpdatedAt: a.now()}
	_ = a.store.Save(ctx, updated)
}

func (a *api) handleWake(w http.ResponseWriter, r *http.Request, id string) {
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
	if !a.authorized(w, r) {
		return
	}
	in, err := a.store.Get(r.Context(), id)
	if errors.Is(err, errNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "database not found", "")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "read metadata", internalDetail(err))
		return
	}
	state, err := a.provisioner.GetState(r.Context(), in)
	if err != nil {
		state = liveState{State: "unknown", Error: err.Error()}
	}
	a.triggerWake(in)
	writeJSON(w, http.StatusOK, map[string]any{
		"id":    in.ID,
		"state": state.State,
		"error": state.Error,
	})
}

func (a *api) triggerWake(in instance) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), wakeRequestTimeout)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(a.provisioner.InternalEndpoint(in), "/")+"/health", nil)
		if err != nil {
			return
		}
		if a.cfg.PlatformSecret != "" {
			req.Header.Set("Authorization", "Bearer "+derivePlatformToken(a.cfg.PlatformSecret, in.ID))
		}
		resp, err := a.wakeClient.Do(req)
		if err == nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
	}()
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
		writeError(w, http.StatusInternalServerError, "internal", "read metadata", internalDetail(err))
		return
	}
	if subtle.ConstantTimeCompare([]byte(tokenHash(token)), []byte(in.TokenHash)) != 1 {
		writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token", "")
		return
	}

	var req execRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body", internalDetail(err))
		return
	}
	body, err := json.Marshal(req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "marshal exec request", internalDetail(err))
		return
	}

	deadline := time.Now().Add(a.execRetryBudget)
	for {
		out, retry, status, code, message, detail := a.execOnce(r.Context(), in, token, body)
		if status == http.StatusOK {
			writeJSON(w, http.StatusOK, out)
			return
		}
		if !retry || time.Now().Add(a.execRetryBackoff).After(deadline) {
			writeError(w, status, code, message, detail)
			return
		}
		select {
		case <-time.After(a.execRetryBackoff):
		case <-r.Context().Done():
			writeError(w, http.StatusGatewayTimeout, "instance_starting", "instance is starting; retry shortly", "request cancelled while waiting for instance startup")
			return
		}
	}
}

func (a *api) execOnce(ctx context.Context, in instance, token string, body []byte) (execResponse, bool, int, string, string, string) {
	upstreamURL := strings.TrimRight(a.provisioner.InternalEndpoint(in), "/") + "/v1/exec"
	upstreamReq, err := http.NewRequestWithContext(ctx, http.MethodPost, upstreamURL, bytes.NewReader(body))
	if err != nil {
		return execResponse{}, false, http.StatusBadGateway, "bad_gateway", "instance unreachable", err.Error()
	}
	upstreamReq.Header.Set("Authorization", "Bearer "+token)
	upstreamReq.Header.Set("Content-Type", "application/json")

	resp, err := a.httpClient.Do(upstreamReq)
	if err != nil {
		if isTimeoutError(err) {
			return execResponse{}, false, http.StatusGatewayTimeout, "gateway_timeout", "instance timed out", ""
		}
		return execResponse{}, false, http.StatusBadGateway, "bad_gateway", "instance unreachable", internalDetail(err)
	}
	defer resp.Body.Close()
	data, err := readAllLimited(resp.Body, maxUpstreamBodyBytes, "instance exec")
	if err != nil {
		return execResponse{}, false, http.StatusBadGateway, "bad_gateway", "read instance response", err.Error()
	}
	contentType := resp.Header.Get("Content-Type")
	if isAzureColdStartResponse(resp.StatusCode, contentType, data) {
		return execResponse{}, true, http.StatusGatewayTimeout, "instance_starting", "instance is starting; retry shortly", "Azure Container Apps reports the instance is stopped or not ready"
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return execResponse{}, false, http.StatusBadGateway, "bad_gateway", "instance returned an error", resp.Status
	}
	if !strings.Contains(strings.ToLower(contentType), "json") && contentType != "" {
		return execResponse{}, false, http.StatusBadGateway, "bad_gateway", "instance returned non-JSON response", summarizeContentType(contentType)
	}
	var out execResponse
	if err := json.Unmarshal(data, &out); err != nil {
		return execResponse{}, false, http.StatusBadGateway, "bad_gateway", "instance returned invalid JSON", err.Error()
	}
	if out.Output == nil {
		return execResponse{}, false, http.StatusBadGateway, "bad_gateway", "instance returned invalid response", ""
	}
	return out, false, http.StatusOK, "", "", ""
}

func (a *api) fetchStatsForList(ctx context.Context, instances []instance) map[string]statsResponse {
	ctx, cancel := context.WithTimeout(ctx, statsListTimeout)
	defer cancel()

	type result struct {
		id    string
		stats statsResponse
	}
	stats := make(map[string]statsResponse, len(instances))
	results := make(chan result, len(instances))
	for _, in := range instances {
		in := in
		go func() {
			results <- result{id: in.ID, stats: a.fetchStats(ctx, in)}
		}()
	}
	for range instances {
		select {
		case got := <-results:
			stats[got.id] = got.stats
		case <-ctx.Done():
			goto fillMissing
		}
	}
fillMissing:
	for _, in := range instances {
		if _, ok := stats[in.ID]; !ok {
			stats[in.ID] = unavailableStats("timeout")
		}
	}
	return stats
}

func (a *api) fetchStats(ctx context.Context, in instance) statsResponse {
	if a.cfg.PlatformSecret == "" {
		return unavailableStats("platform_token_unconfigured")
	}
	// Deliberately check Azure state before touching /v1/stats: this dashboard
	// is polled often, so an instance scaled to zero should show unavailable
	// promptly rather than being cold-started just to draw a chart.
	state, err := a.provisioner.GetState(ctx, in)
	if err != nil {
		return unavailableStats("state_unavailable")
	}
	if state.State != "running" {
		return unavailableStats(state.State)
	}

	reqCtx, cancel := context.WithTimeout(ctx, statsRequestTimeout)
	defer cancel()
	upstreamURL := strings.TrimRight(a.provisioner.InternalEndpoint(in), "/") + "/v1/stats"
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, upstreamURL, nil)
	if err != nil {
		return unavailableStats("unavailable")
	}
	req.Header.Set("Authorization", "Bearer "+derivePlatformToken(a.cfg.PlatformSecret, in.ID))

	resp, err := a.statsClient.Do(req)
	if err != nil {
		return unavailableStats("unavailable")
	}
	defer resp.Body.Close()
	data, err := readAllLimited(resp.Body, maxUpstreamBodyBytes, "instance stats")
	if err != nil {
		return unavailableStats("unavailable")
	}
	if isAzureColdStartResponse(resp.StatusCode, resp.Header.Get("Content-Type"), data) {
		return unavailableStats("instance_starting")
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return unavailableStats("unavailable")
	}
	if !strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "json") && resp.Header.Get("Content-Type") != "" {
		return unavailableStats("unavailable")
	}
	if !json.Valid(data) {
		return unavailableStats("unavailable")
	}
	a.recordStatsReport(context.Background(), in, data)
	return statsResponse{Available: true, Stats: json.RawMessage(data)}
}

func (a *api) recordStatsReport(ctx context.Context, in instance, data []byte) {
	var report struct {
		Engine        string `json:"engine"`
		StorageFormat string `json:"storageFormat"`
	}
	if err := json.Unmarshal(data, &report); err != nil {
		return
	}
	if report.Engine == "" && report.StorageFormat == "" {
		return
	}
	_ = a.store.Save(ctx, a.applyInstanceReport(ctx, in, report.Engine, report.StorageFormat))
}

func (a *api) backupInstance(ctx context.Context, in instance) error {
	reqCtx, cancel := context.WithTimeout(ctx, a.backupTimeout)
	defer cancel()

	// This deliberately does not use /v1/exec. The control plane stores only a
	// hash of the customer's instance token, and the platform token must never
	// become a fleet-wide write credential. The sidecar route is a narrow
	// pre-upgrade capability: it may take/verify the snapshot needed before an
	// image change, and nothing else.
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, strings.TrimRight(a.provisioner.InternalEndpoint(in), "/")+"/v1/prepare-upgrade", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+derivePlatformToken(a.cfg.PlatformSecret, in.ID))
	resp, err := a.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("prepare-upgrade returned %s", resp.Status)
	}
	data, err := readAllLimited(resp.Body, maxUpstreamBodyBytes, "prepare-upgrade")
	if err != nil {
		return err
	}
	var out prepareUpgradeResponse
	if err := json.Unmarshal(data, &out); err != nil {
		return err
	}
	if !out.OK {
		if out.Detail != "" {
			return fmt.Errorf("prepare-upgrade failed: %s", out.Detail)
		}
		return fmt.Errorf("prepare-upgrade failed")
	}
	return nil
}

func (a *api) refreshEngine(ctx context.Context, in instance) (healthResponse, bool) {
	reqCtx, cancel := context.WithTimeout(ctx, healthCheckTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, strings.TrimRight(a.provisioner.InternalEndpoint(in), "/")+"/health", nil)
	if err != nil {
		return healthResponse{}, false
	}
	resp, err := a.statsClient.Do(req)
	if err != nil {
		return healthResponse{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return healthResponse{}, false
	}
	var health healthResponse
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil || health.Engine == "" {
		return healthResponse{}, false
	}
	return health, true
}

func unavailableStats(reason string) statsResponse {
	if reason == "" {
		reason = "unavailable"
	}
	return statsResponse{Available: false, Reason: reason}
}

func includeStats(r *http.Request) bool {
	value := strings.ToLower(r.URL.Query().Get("include_stats"))
	return value == "1" || value == "true" || value == "yes"
}

func (a *api) upgradeAvailable(in instance) bool {
	current := a.availableEngine()
	if current == "unknown" {
		return false
	}
	if source := engineSourceForInstance(in); source == "instance" {
		return engineForInstance(in) != current
	}
	_, currentOK := imageTag(a.cfg.Image)
	_, recordedOK := imageTag(in.Image)
	return currentOK && recordedOK && in.Image != a.cfg.Image
}

func (a *api) responseFor(ctx context.Context, in instance) databaseResponse {
	in = a.expireStaleOperation(context.Background(), in)
	state, err := a.provisioner.GetState(ctx, in)
	if err != nil {
		state = liveState{State: "failed", Error: err.Error()}
	}
	return databaseResponse{
		ID:               in.ID,
		Name:             in.Name,
		Tier:             in.Tier,
		Image:            in.Image,
		Engine:           engineForInstance(in),
		State:            state.State,
		Endpoint:         a.provisioner.Endpoint(in),
		CreatedAt:        in.CreatedAt.Format(time.RFC3339),
		Error:            state.Error,
		StorageFormat:    in.StorageFormat,
		EngineSource:     engineSourceForInstance(in),
		Operation:        operationForResponse(in.Operation),
		UpgradeAvailable: a.upgradeAvailable(in),
		AvailableEngine:  a.availableEngine(),
		AvailableImage:   a.availableImage(),
	}
}

func (a *api) applyInstanceReport(ctx context.Context, in instance, engine, storageFormat string) instance {
	engine = strings.TrimSpace(engine)
	if engine != "" {
		in.Engine = engine
		in.EngineSource = "instance"
		if engine == a.availableEngine() {
			in.Image = a.cfg.Image
		}
	}
	if strings.TrimSpace(storageFormat) != "" {
		in.StorageFormat = strings.TrimSpace(storageFormat)
	}
	return in
}

func (a *api) updateOperationState(ctx context.Context, id, state, detail string) {
	in, err := a.store.Get(ctx, id)
	if err != nil || in.Operation == nil {
		return
	}
	in.Operation.State = state
	in.Operation.UpdatedAt = a.now()
	in.Operation.Error = detail
	_ = a.store.Save(ctx, in)
}

func (a *api) expireStaleOperation(ctx context.Context, in instance) instance {
	if in.Operation == nil {
		return in
	}
	now := a.now()
	if in.Operation.Type == "rotate-token" && in.Operation.PendingToken != "" {
		expires := in.Operation.PendingTokenExpiresAt
		if expires.IsZero() {
			expires = in.Operation.UpdatedAt.Add(pendingTokenTTL)
			if in.Operation.UpdatedAt.IsZero() {
				expires = now.Add(pendingTokenTTL)
			}
			in.Operation.PendingTokenExpiresAt = expires
		}
		if !now.After(expires) {
			if encrypted, err := encryptRotationToken(a.cfg.PlatformSecret, in.ID, in.Operation.PendingToken); err == nil {
				in.Operation.PendingTokenEncrypted = encrypted
			}
		}
		in.Operation.PendingToken = ""
		in.Operation.UpdatedAt = now
		_ = a.store.Save(ctx, in)
	}
	if in.Operation.Type == "rotate-token" && !in.Operation.PendingTokenExpiresAt.IsZero() && now.After(in.Operation.PendingTokenExpiresAt) && in.Operation.PendingTokenEncrypted != "" {
		in.Operation.PendingToken = ""
		in.Operation.PendingTokenEncrypted = ""
		in.Operation.PendingTokenExpiresAt = time.Time{}
		if in.Operation.State == "pending_ack" {
			in.Operation.State = "failed"
			in.Operation.Error = "pending token rotation expired before commit; prepare a new rotation"
		}
		in.Operation.UpdatedAt = now
		_ = a.store.Save(ctx, in)
		return in
	}
	if !operationActive(in.Operation) || now.Sub(in.Operation.UpdatedAt) <= operationStaleAfter {
		return in
	}
	in.Operation.State = "failed"
	in.Operation.UpdatedAt = now
	in.Operation.Error = "operation expired after control-plane restart or timeout; poll state and retry if needed"
	in.Operation.PendingToken = ""
	in.Operation.PendingTokenEncrypted = ""
	in.Operation.PendingTokenExpiresAt = time.Time{}
	_ = a.store.Save(ctx, in)
	return in
}

func operationForResponse(op *operation) *operationResponse {
	if op == nil {
		return nil
	}
	return &operationResponse{
		Type:      op.Type,
		State:     op.State,
		StartedAt: op.StartedAt,
		UpdatedAt: op.UpdatedAt,
		Error:     op.Error,
	}
}

func operationActive(op *operation) bool {
	return op != nil && op.State != "done" && op.State != "failed"
}

func previousOperationStarted(op *operation, fallback time.Time) time.Time {
	if op != nil && !op.StartedAt.IsZero() {
		return op.StartedAt
	}
	return fallback
}

func (a *api) availableEngine() string {
	return engineFromImage(a.cfg.Image)
}

func (a *api) availableImage() string {
	if _, ok := imageTag(a.cfg.Image); !ok {
		return ""
	}
	return a.cfg.Image
}

func imageTag(image string) (string, bool) {
	if image == "" || strings.Contains(image, "@") {
		return "", false
	}
	lastSlash := strings.LastIndexByte(image, '/')
	if colon := strings.LastIndexByte(image, ':'); colon > lastSlash {
		tag := image[colon+1:]
		return tag, versionTagPattern.MatchString(tag)
	}
	return "", false
}

func engineFromImage(image string) string {
	if tag, ok := imageTag(image); ok {
		return tag
	}
	return "unknown"
}

func engineForInstance(in instance) string {
	if strings.TrimSpace(in.Engine) != "" {
		return in.Engine
	}
	return engineFromImage(in.Image)
}

func engineSourceForInstance(in instance) string {
	if in.EngineSource != "" {
		return in.EngineSource
	}
	if strings.TrimSpace(in.Engine) != "" && in.Engine != engineFromImage(in.Image) {
		return "instance"
	}
	return "image"
}

func (a *api) authorized(w http.ResponseWriter, r *http.Request) bool {
	_, ok := a.authorizedActor(w, r)
	return ok
}

// authorizedActor is authorized() plus the identity of the caller, for routes
// that change or destroy something and therefore have to be attributable.
func (a *api) authorizedActor(w http.ResponseWriter, r *http.Request) (string, bool) {
	token, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok || a.verifier == nil || a.cfg.EntraGroupID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token", "")
		return "", false
	}
	claims, err := a.verifier.Verify(r.Context(), token)
	if err != nil || !containsString(claims.Scopes, entraScopeName) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token", "")
		return "", false
	}
	if !containsString(claims.Groups, a.cfg.EntraGroupID) {
		writeError(w, http.StatusForbidden, "forbidden", "required group membership missing", "")
		return "", false
	}
	return claims.Subject, true
}

// audit records who did what to which database. It never receives a token: the
// point is attribution, and a log line is a place secrets end up by accident.
func (a *api) audit(actor, action, id, result string) {
	if actor == "" {
		actor = "unknown"
	}
	if id == "" {
		id = "-"
	}
	log.Printf("audit actor=%s action=%s database=%s result=%s", actor, action, id, result)
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

func isAzureColdStartResponse(status int, contentType string, body []byte) bool {
	if status != http.StatusNotFound && status != http.StatusServiceUnavailable {
		return false
	}
	lowerType := strings.ToLower(contentType)
	lowerBody := strings.ToLower(string(body))
	return strings.Contains(lowerType, "html") &&
		(strings.Contains(lowerBody, "azure container app - unavailable") ||
			strings.Contains(lowerBody, "container app is stopped or does not exist"))
}

func summarizeContentType(contentType string) string {
	if contentType == "" {
		return "missing Content-Type"
	}
	return "Content-Type: " + contentType
}

// internalDetail keeps the operator's diagnostic and hands the caller only a
// reference to it. ARM errors carry the subscription id, the resource group and
// Azure correlation ids, and execOnce's error carries the instance's internal
// Container Apps FQDN — which a caller holding only a database token could read,
// so internal topology crossed the control-plane/data-plane boundary.
func internalDetail(err error) string {
	if err == nil {
		return ""
	}
	var raw [8]byte
	if _, rerr := rand.Read(raw[:]); rerr != nil {
		log.Printf("error ref=unavailable detail=%v", err)
		return "see server logs"
	}
	ref := hex.EncodeToString(raw[:])
	log.Printf("error ref=%s detail=%v", ref, err)
	return "reference " + ref
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
