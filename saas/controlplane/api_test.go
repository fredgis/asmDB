package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

const azureColdStartHTML = `<!doctype html>
<html><head><title>Azure Container App - Unavailable</title></head>
<body><h1 id="unavailable">Error 404 - This Container App is stopped or does not exist.</h1></body></html>`

type fakeProvisioner struct {
	created          []instance
	endpoint         string
	internalEndpoint string
	rotated          []string
	rotateErr        error
	upgraded         []string
	upgradeErr       error
	replicas         map[string][]replicaSample
	replicaErr       error
	states           map[string]liveState
}

func (p *fakeProvisioner) Create(_ context.Context, in instance, token string) (string, error) {
	if token == "" {
		panic("empty token")
	}
	p.created = append(p.created, in)
	return "https://" + in.ContainerAppName + ".example.test", nil
}

func (p *fakeProvisioner) GetState(_ context.Context, in instance) (liveState, error) {
	if state, ok := p.states[in.ID]; ok {
		return state, nil
	}
	return liveState{State: "running"}, nil
}

func (p *fakeProvisioner) Delete(_ context.Context, _ instance) error {
	return nil
}

func (p *fakeProvisioner) RotateToken(_ context.Context, _ instance, token string, progress func(string)) error {
	if p.rotateErr != nil {
		return p.rotateErr
	}
	if progress != nil {
		progress("stopping")
		progress("starting")
		progress("verifying_health")
	}
	p.rotated = append(p.rotated, token)
	return nil
}

func (p *fakeProvisioner) UpgradeImage(_ context.Context, _ instance, image string, progress func(string)) error {
	if p.upgradeErr != nil {
		return p.upgradeErr
	}
	if progress != nil {
		progress("stopping")
		progress("starting")
		progress("verifying_health")
	}
	p.upgraded = append(p.upgraded, image)
	return nil
}

func (p *fakeProvisioner) ReplicaAverages(_ context.Context, in instance, _, _ time.Time, _ time.Duration) ([]replicaSample, error) {
	if p.replicaErr != nil {
		return nil, p.replicaErr
	}
	return p.replicas[in.ID], nil
}

func (p *fakeProvisioner) Endpoint(in instance) string {
	if p.endpoint != "" {
		return p.endpoint
	}
	return "https://" + in.ContainerAppName + ".example.test"
}

func (p *fakeProvisioner) InternalEndpoint(in instance) string {
	if p.internalEndpoint != "" {
		return p.internalEndpoint
	}
	return "https://" + in.ContainerAppName + ".internal.example.test"
}

type fakeAccessTokenVerifier struct {
	claims verifiedAccessToken
	err    error
	seen   []string
}

func (v *fakeAccessTokenVerifier) Verify(_ context.Context, raw string) (verifiedAccessToken, error) {
	v.seen = append(v.seen, raw)
	if v.err != nil {
		return verifiedAccessToken{}, v.err
	}
	return v.claims, nil
}

func testConfig() config {
	clientID := "<console-app-id>"
	return config{
		EntraTenantID: "<tenant-id>",
		EntraClientID: clientID,
		EntraGroupID:  "<admin-group-id>",
		EntraScope:    "api://" + clientID + "/" + entraScopeName,
	}
}

func testStatsConfig() config {
	cfg := testConfig()
	cfg.PlatformSecret = "test-platform-secret"
	cfg.Image = "reg.azurecr.io/asmdb-instance:1.6.0"
	return cfg
}

func allowVerifier() *fakeAccessTokenVerifier {
	cfg := testConfig()
	return &fakeAccessTokenVerifier{claims: verifiedAccessToken{
		Groups: []string{cfg.EntraGroupID},
		Scopes: []string{entraScopeName},
	}}
}

func waitForOperationState(t *testing.T, s store, id, want string) instance {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		in, err := s.Get(context.Background(), id)
		if err == nil && in.Operation != nil && in.Operation.State == want {
			return in
		}
		if time.Now().After(deadline) {
			if err != nil {
				t.Fatalf("operation did not reach %q: %v", want, err)
			}
			in, _ := s.Get(context.Background(), id)
			t.Fatalf("operation = %+v, want state %q", in.Operation, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func newTestAPI(store store, prov provisioner) *api {
	cfg := testConfig()
	cfg.PlatformSecret = "test-platform-secret"
	return newAPI(store, prov, cfg, allowVerifier())
}

func newStatsTestAPI(store store, prov provisioner) *api {
	return newAPI(store, prov, testStatsConfig(), allowVerifier())
}

func decodeErrorCode(t *testing.T, body io.Reader) string {
	t.Helper()
	var got struct {
		Error struct {
			Code   string `json:"code"`
			Detail string `json:"detail"`
		} `json:"error"`
	}
	if err := json.NewDecoder(body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	return got.Error.Code + "|" + got.Error.Detail
}

func TestValidName(t *testing.T) {
	// CONTRACTS.md §2: 2–40 chars, ^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$.
	// Built rather than typed, so the boundary cases cannot drift from the
	// number they claim to test.
	name := func(n int) string { return "a" + strings.Repeat("b", n-2) + "z" }

	valid := []string{"my-notes", "a1", "abc123", "a-b-c", name(39), name(40)}
	for _, n := range valid {
		if !validName(n) {
			t.Fatalf("expected valid name %q (%d chars)", n, len(n))
		}
	}
	invalid := []string{"", "a", "-abc", "abc-", "ABC", "a_b", "a..b", name(41)}
	for _, n := range invalid {
		if validName(n) {
			t.Fatalf("expected invalid name %q (%d chars)", n, len(n))
		}
	}
}

func TestHealthz(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	handleHealthz(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "ok\n" {
		t.Fatalf("body = %q, want ok", got)
	}
}

func TestCreateDatabaseAndTokenOnlyOnce(t *testing.T) {
	store := newMemoryStore()
	prov := &fakeProvisioner{states: map[string]liveState{}}
	cfg := testConfig()
	cfg.Image = "reg.azurecr.io/asmdb-instance:1.5.0"
	api := newAPI(store, prov, cfg, allowVerifier())
	api.now = func() time.Time { return time.Date(2026, 7, 25, 19, 40, 0, 0, time.UTC) }

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases", bytes.NewBufferString(`{"name":"my-notes","tier":"free"}`))
	api.createDatabase(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var created databaseResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Token == "" || created.State != "provisioning" {
		t.Fatalf("bad create response: %+v", created)
	}
	if created.Image != cfg.Image {
		t.Fatalf("created image = %q, want %q", created.Image, cfg.Image)
	}
	if created.Engine != "1.5.0" {
		t.Fatalf("created engine = %q, want 1.5.0", created.Engine)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/databases/"+created.ID, nil)
	api.getDatabase(rec, req, created.ID)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var got databaseResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Token != "" {
		t.Fatal("GET returned token")
	}
}

func TestQuotaEnforcement(t *testing.T) {
	store := newMemoryStore()
	for i := 0; i < tierSpecs["free"].Quota; i++ {
		in := instance{ID: "db_quota", Name: "n", Tier: "free", CreatedAt: time.Now().UTC(), ContainerAppName: "db-quota"}
		in.ID = in.ID + string(rune('a'+i))
		if err := store.Save(context.Background(), in); err != nil {
			t.Fatal(err)
		}
	}
	api := newTestAPI(store, &fakeProvisioner{states: map[string]liveState{}})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases", bytes.NewBufferString(`{"name":"another","tier":"free"}`))
	api.createDatabase(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestManagementNoTokenGets401(t *testing.T) {
	api := newAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}}, testConfig(), allowVerifier())
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/databases", nil)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestManagementBadSignatureGets401(t *testing.T) {
	verifier := &fakeAccessTokenVerifier{err: errors.New("bad signature")}
	api := newAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}}, testConfig(), verifier)
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/databases", nil)
	req.Header.Set("Authorization", "Bearer bad")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestManagementMissingGroupGets403(t *testing.T) {
	verifier := &fakeAccessTokenVerifier{claims: verifiedAccessToken{Scopes: []string{entraScopeName}}}
	api := newAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}}, testConfig(), verifier)
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/databases", nil)
	req.Header.Set("Authorization", "Bearer token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestOpenHealthzAndConfig(t *testing.T) {
	api := newAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}}, testConfig(), nil)
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("health status = %d body = %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/config", nil)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("config status = %d body = %s", rec.Code, rec.Body.String())
	}
	var got map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig()
	if got["tenantId"] != cfg.EntraTenantID || got["clientId"] != cfg.EntraClientID || got["scope"] != cfg.EntraScope {
		t.Fatalf("config = %+v, want tenant/client/scope from config", got)
	}
}

func TestVersionEndpointIsOpen(t *testing.T) {
	api := newAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}}, testStatsConfig(), nil)
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/version", nil)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var got versionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Engine != "1.6.0" || got.Image != "reg.azurecr.io/asmdb-instance:1.6.0" {
		t.Fatalf("version = %+v", got)
	}
}

func TestUpgradeAvailabilityFromVersionTags(t *testing.T) {
	tests := []struct {
		name             string
		recorded         string
		current          string
		wantAvailable    bool
		wantRunsEngine   string
		wantEngine       string
		wantAvailableImg string
	}{
		{
			name:             "equal tags",
			recorded:         "reg.azurecr.io/asmdb-instance:1.5.0",
			current:          "reg.azurecr.io/asmdb-instance:1.5.0",
			wantRunsEngine:   "1.5.0",
			wantEngine:       "1.5.0",
			wantAvailableImg: "reg.azurecr.io/asmdb-instance:1.5.0",
		},
		{
			name:             "different tags",
			recorded:         "reg.azurecr.io/asmdb-instance:1.5.0",
			current:          "reg.azurecr.io/asmdb-instance:1.5.1",
			wantAvailable:    true,
			wantRunsEngine:   "1.5.0",
			wantEngine:       "1.5.1",
			wantAvailableImg: "reg.azurecr.io/asmdb-instance:1.5.1",
		},
		{
			name:             "recorded missing tag cannot tell",
			recorded:         "reg.azurecr.io/asmdb-instance",
			current:          "reg.azurecr.io/asmdb-instance:1.5.1",
			wantRunsEngine:   "unknown",
			wantEngine:       "1.5.1",
			wantAvailableImg: "reg.azurecr.io/asmdb-instance:1.5.1",
		},
		{
			name:           "current missing tag cannot tell",
			recorded:       "reg.azurecr.io/asmdb-instance:1.5.0",
			current:        "reg.azurecr.io/asmdb-instance",
			wantRunsEngine: "1.5.0",
			wantEngine:     "unknown",
		},
		{
			name:           "digest current cannot tell",
			recorded:       "reg.azurecr.io/asmdb-instance:1.5.0",
			current:        "reg.azurecr.io/asmdb-instance@sha256:abc",
			wantRunsEngine: "1.5.0",
			wantEngine:     "unknown",
		},
		{
			name:           "empty current cannot tell",
			recorded:       "reg.azurecr.io/asmdb-instance:1.5.0",
			wantRunsEngine: "1.5.0",
			wantEngine:     "unknown",
		},
		{
			name:             "latest recorded is unknown",
			recorded:         "reg.azurecr.io/asmdb-instance:latest",
			current:          "reg.azurecr.io/asmdb-instance:1.5.1",
			wantRunsEngine:   "unknown",
			wantEngine:       "1.5.1",
			wantAvailableImg: "reg.azurecr.io/asmdb-instance:1.5.1",
		},
		{
			name:             "digest recorded is unknown",
			recorded:         "reg.azurecr.io/asmdb-instance@sha256:abc",
			current:          "reg.azurecr.io/asmdb-instance:1.5.1",
			wantRunsEngine:   "unknown",
			wantEngine:       "1.5.1",
			wantAvailableImg: "reg.azurecr.io/asmdb-instance:1.5.1",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := testConfig()
			cfg.Image = tt.current
			api := newAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}}, cfg, allowVerifier())
			got := api.responseFor(context.Background(), instance{
				ID:               "db_abcdefghijklmnopqrstuvwx",
				Name:             "db",
				Tier:             "free",
				Image:            tt.recorded,
				CreatedAt:        time.Now().UTC(),
				ContainerAppName: "db-test",
			})
			if got.UpgradeAvailable != tt.wantAvailable || got.Engine != tt.wantRunsEngine || got.AvailableEngine != tt.wantEngine || got.AvailableImage != tt.wantAvailableImg {
				t.Fatalf("response = %+v, want available=%v runs=%q availableEngine=%q image=%q", got, tt.wantAvailable, tt.wantRunsEngine, tt.wantEngine, tt.wantAvailableImg)
			}
		})
	}
}

func TestHealthEngineOverridesImageTag(t *testing.T) {
	api := newAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}}, testStatsConfig(), allowVerifier())
	got := api.responseFor(context.Background(), instance{
		ID:               "db_abcdefghijklmnopqrstuvwx",
		Name:             "db",
		Tier:             "free",
		Image:            "reg.azurecr.io/asmdb-instance:1.5.0",
		Engine:           "1.5.0+hotfix",
		CreatedAt:        time.Now().UTC(),
		ContainerAppName: "db-test",
	})
	if got.Engine != "1.5.0+hotfix" {
		t.Fatalf("engine = %q, want health-reported version", got.Engine)
	}
	if got.EngineSource != "instance" {
		t.Fatalf("engineSource = %q, want instance", got.EngineSource)
	}
}

func TestInstanceReportedEngineSuppressesSpuriousUpgrade(t *testing.T) {
	api := newAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}}, testStatsConfig(), allowVerifier())
	got := api.responseFor(context.Background(), instance{
		ID:               "db_abcdefghijklmnopqrstuvwx",
		Name:             "db",
		Tier:             "free",
		Image:            "reg.azurecr.io/asmdb-instance:1.5.1",
		Engine:           "1.6.0",
		EngineSource:     "instance",
		CreatedAt:        time.Now().UTC(),
		ContainerAppName: "db-test",
	})
	if got.UpgradeAvailable {
		t.Fatalf("upgradeAvailable = true for instance-reported current engine")
	}
}

func TestRotateTokenPreparesThenCommitsAsynchronously(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	oldHash := tokenHash("old-token")
	if err := store.Save(context.Background(), instance{ID: id, Name: "db", Tier: "free", TokenHash: oldHash, ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	prov := &fakeProvisioner{states: map[string]liveState{}}
	api := newTestAPI(store, prov)
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/rotate-token", nil)
	req.Header.Set("Authorization", "Bearer admin-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("prepare status = %d body = %s", rec.Code, rec.Body.String())
	}
	var prepared struct {
		Token     string             `json:"token"`
		Operation *operationResponse `json:"operation"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &prepared); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(prepared.Token) {
		t.Fatalf("unexpected token shape: %q", prepared.Token)
	}
	got, _ := store.Get(context.Background(), id)
	if got.TokenHash != oldHash {
		t.Fatalf("hash changed before commit: %q", got.TokenHash)
	}
	if got.Operation == nil || got.Operation.State != "pending_ack" || got.Operation.PendingToken != "" || got.Operation.PendingTokenEncrypted == "" || strings.Contains(got.Operation.PendingTokenEncrypted, prepared.Token) {
		t.Fatalf("operation = %+v, want pending_ack with encrypted token only", got.Operation)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/rotate-token/commit", nil)
	req.Header.Set("Authorization", "Bearer admin-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("commit status = %d body = %s", rec.Code, rec.Body.String())
	}
	updated := waitForOperationState(t, store, id, "done")
	if len(prov.rotated) != 1 || prov.rotated[0] != prepared.Token {
		t.Fatalf("pushed tokens = %#v, want prepared token", prov.rotated)
	}
	if updated.TokenHash != tokenHash(prepared.Token) {
		t.Fatal("store does not contain committed token hash")
	}
	if updated.Operation.PendingToken != "" || updated.Operation.PendingTokenEncrypted != "" {
		t.Fatal("committed token was not purged from operation")
	}
}

func TestRotateTokenPrepareLeavesOldTokenWorkingIfClientDisconnects(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	oldHash := tokenHash("old-token")
	if err := store.Save(context.Background(), instance{ID: id, Name: "db", Tier: "free", TokenHash: oldHash, ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	api := newTestAPI(store, &fakeProvisioner{states: map[string]liveState{}})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/rotate-token", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	got, _ := store.Get(context.Background(), id)
	if got.TokenHash != oldHash {
		t.Fatalf("hash = %q, want old hash until commit", got.TokenHash)
	}
	if got.Operation == nil || got.Operation.PendingToken != "" || got.Operation.PendingTokenEncrypted == "" {
		t.Fatalf("operation = %+v, want encrypted recoverable token", got.Operation)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/databases/"+id, nil)
	req.Header.Set("Authorization", "Bearer test-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d body = %s", rec.Code, rec.Body.String())
	}
	var body databaseResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Operation == nil || body.Operation.State != "pending_ack" || strings.Contains(rec.Body.String(), "pendingToken") {
		t.Fatalf("database response leaked pending token: %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/databases", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d body = %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "pendingToken") || strings.Contains(rec.Body.String(), got.Operation.PendingTokenEncrypted) {
		t.Fatalf("list response leaked pending token material: %s", rec.Body.String())
	}
}

func TestRotateTokenPrepareRecoveryReturnsSameTokenWithinTTL(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	if err := store.Save(context.Background(), instance{ID: id, Name: "db", Tier: "free", TokenHash: tokenHash("old-token"), ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	api := newTestAPI(store, &fakeProvisioner{states: map[string]liveState{}})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/rotate-token", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("prepare status = %d body = %s", rec.Code, rec.Body.String())
	}
	var first rotateTokenResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/rotate-token", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("recovery status = %d body = %s", rec.Code, rec.Body.String())
	}
	var second rotateTokenResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if second.Token != first.Token || second.Token == "" {
		t.Fatalf("recovered token = %q, want original %q", second.Token, first.Token)
	}
}

func TestRotateTokenPendingExpiresAndDiscardsToken(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	if err := store.Save(context.Background(), instance{ID: id, Name: "db", Tier: "free", TokenHash: tokenHash("old-token"), ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 26, 20, 0, 0, 0, time.UTC)
	api := newTestAPI(store, &fakeProvisioner{states: map[string]liveState{}})
	api.now = func() time.Time { return now }
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/rotate-token", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("prepare status = %d body = %s", rec.Code, rec.Body.String())
	}
	var first rotateTokenResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}

	now = now.Add(pendingTokenTTL + time.Second)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/rotate-token/commit", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expired commit status = %d body = %s", rec.Code, rec.Body.String())
	}
	expired, _ := store.Get(context.Background(), id)
	if expired.Operation == nil || expired.Operation.State != "failed" || expired.Operation.PendingTokenEncrypted != "" {
		t.Fatalf("expired operation = %+v, want failed with no token material", expired.Operation)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/rotate-token", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("new prepare status = %d body = %s", rec.Code, rec.Body.String())
	}
	var second rotateTokenResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if second.Token == "" || second.Token == first.Token {
		t.Fatalf("new token = %q, old token = %q", second.Token, first.Token)
	}
}

func TestRotateTokenUnknownIDGets404(t *testing.T) {
	api := newTestAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/db_abcdefghijklmnopqrstuvwx/rotate-token", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestRotateTokenRequiresEntraToken(t *testing.T) {
	api := newTestAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/db_abcdefghijklmnopqrstuvwx/rotate-token", nil)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestRotateTokenRequiresAdminGroup(t *testing.T) {
	verifier := &fakeAccessTokenVerifier{claims: verifiedAccessToken{Scopes: []string{entraScopeName}}}
	api := newAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}}, testConfig(), verifier)
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/db_abcdefghijklmnopqrstuvwx/rotate-token", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestRotateTokenCommitFailureLeavesOldHashAndNewTokenRecoverable(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	oldHash := tokenHash("old-token")
	if err := store.Save(context.Background(), instance{ID: id, Name: "db", Tier: "free", TokenHash: oldHash, ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	api := newTestAPI(store, &fakeProvisioner{rotateErr: errors.New("update failed"), states: map[string]liveState{}})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/rotate-token", nil)
	req.Header.Set("Authorization", "Bearer admin-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("prepare status = %d body = %s", rec.Code, rec.Body.String())
	}
	prepared, _ := store.Get(context.Background(), id)
	pending, err := decryptRotationToken(api.cfg.PlatformSecret, id, prepared.Operation.PendingTokenEncrypted)
	if err != nil {
		t.Fatal(err)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/rotate-token/commit", nil)
	req.Header.Set("Authorization", "Bearer admin-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("commit status = %d body = %s", rec.Code, rec.Body.String())
	}
	got := waitForOperationState(t, store, id, "failed")
	if got.TokenHash != oldHash {
		t.Fatalf("hash = %q, want old hash restored", got.TokenHash)
	}
	recovered, err := decryptRotationToken(api.cfg.PlatformSecret, id, got.Operation.PendingTokenEncrypted)
	if err != nil {
		t.Fatal(err)
	}
	if recovered != pending || pending == "" {
		t.Fatalf("pending token = %q, want recoverable %q", recovered, pending)
	}
}

func TestUpgradeRefusedWhenCurrentImage(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	cfg := testStatsConfig()
	if err := store.Save(context.Background(), instance{ID: id, Tier: "free", Image: cfg.Image, ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	prov := &fakeProvisioner{states: map[string]liveState{}}
	api := newAPI(store, prov, cfg, allowVerifier())
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/upgrade", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if len(prov.upgraded) != 0 {
		t.Fatalf("upgrade called: %#v", prov.upgraded)
	}
}

func TestUpgradeBackupFailureAborts(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	oldImage := "reg.azurecr.io/asmdb-instance:1.5.0"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "free", Image: oldImage, ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/prepare-upgrade" {
			t.Fatalf("unexpected backup path %q", r.URL.Path)
		}
		writeJSON(w, http.StatusOK, prepareUpgradeResponse{OK: false, Detail: "backup failed"})
	}))
	defer server.Close()
	prov := &fakeProvisioner{internalEndpoint: server.URL, states: map[string]liveState{}}
	api := newAPI(store, prov, testStatsConfig(), allowVerifier())
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/upgrade", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	waitForOperationState(t, store, id, "failed")
	if len(prov.upgraded) != 0 {
		t.Fatalf("upgrade called after backup failure: %#v", prov.upgraded)
	}
	got, _ := store.Get(context.Background(), id)
	if got.Image != oldImage {
		t.Fatalf("image = %q, want %q", got.Image, oldImage)
	}
}

func TestUpgradePrepareUnauthorizedAbortsWithoutChangingImage(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	oldImage := "reg.azurecr.io/asmdb-instance:1.5.0"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "free", Image: oldImage, ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/exec" {
			t.Fatal("upgrade must not use the general exec route for backup")
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer server.Close()
	prov := &fakeProvisioner{internalEndpoint: server.URL, states: map[string]liveState{}}
	api := newAPI(store, prov, testStatsConfig(), allowVerifier())
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/upgrade", nil)
	req.Header.Set("Authorization", "Bearer admin-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	waitForOperationState(t, store, id, "failed")
	if len(prov.upgraded) != 0 {
		t.Fatalf("upgrade called after prepare failure: %#v", prov.upgraded)
	}
	got, _ := store.Get(context.Background(), id)
	if got.Image != oldImage {
		t.Fatalf("image = %q, want %q", got.Image, oldImage)
	}
}

func TestUpgradeRevisionFailureLeavesRecordedImageUnchanged(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	oldImage := "reg.azurecr.io/asmdb-instance:1.5.0"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "free", Image: oldImage, ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/prepare-upgrade" {
			t.Fatalf("unexpected backup path %q", r.URL.Path)
		}
		writeJSON(w, http.StatusOK, prepareUpgradeResponse{OK: true, Backup: json.RawMessage(`{"path":"snapshot"}`)})
	}))
	defer server.Close()
	prov := &fakeProvisioner{internalEndpoint: server.URL, upgradeErr: errors.New("revision failed"), states: map[string]liveState{}}
	api := newAPI(store, prov, testStatsConfig(), allowVerifier())
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/upgrade", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	waitForOperationState(t, store, id, "failed")
	got, _ := store.Get(context.Background(), id)
	if got.Image != oldImage {
		t.Fatalf("image = %q, want %q after failed revision", got.Image, oldImage)
	}
}

func TestUpgradeStoppedInstanceIsDeliberatelyStarted(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	oldImage := "reg.azurecr.io/asmdb-instance:1.5.0"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "free", Image: oldImage, ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	backupCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/prepare-upgrade" {
			backupCalls++
			if got, want := r.Header.Get("Authorization"), "Bearer "+derivePlatformToken(testStatsConfig().PlatformSecret, id); got != want {
				t.Fatalf("prepare-upgrade auth = %q, want %q", got, want)
			}
			writeJSON(w, http.StatusOK, prepareUpgradeResponse{OK: true, Backup: json.RawMessage(`{"path":"snapshot"}`)})
			return
		}
		writeJSON(w, http.StatusOK, healthResponse{Status: "ok", Engine: "1.6.0"})
	}))
	defer server.Close()
	prov := &fakeProvisioner{
		internalEndpoint: server.URL,
		states:           map[string]liveState{id: {State: "stopped"}},
	}
	api := newAPI(store, prov, testStatsConfig(), allowVerifier())
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/upgrade", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	waitForOperationState(t, store, id, "done")
	if backupCalls != 1 || len(prov.upgraded) != 1 {
		t.Fatalf("backupCalls=%d upgraded=%#v, want one backup and one upgrade", backupCalls, prov.upgraded)
	}
	got, _ := store.Get(context.Background(), id)
	if got.Image != testStatsConfig().Image || got.Engine != "1.6.0" {
		t.Fatalf("stored instance = %+v", got)
	}
}

func TestUpgradeReturnsAcceptedPromptlyAndExposesStates(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	_ = store.Save(context.Background(), instance{ID: id, Tier: "free", Image: "reg.azurecr.io/asmdb-instance:1.5.0", ContainerAppName: "db-test"})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		writeJSON(w, http.StatusOK, prepareUpgradeResponse{OK: true, Backup: json.RawMessage(`{"path":"snapshot"}`)})
	}))
	defer server.Close()
	prov := &fakeProvisioner{internalEndpoint: server.URL, states: map[string]liveState{}}
	api := newAPI(store, prov, testStatsConfig(), allowVerifier())
	mux := http.NewServeMux()
	api.register(mux)

	start := time.Now()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/upgrade", nil)
	req.Header.Set("Authorization", "Bearer admin-token")
	mux.ServeHTTP(rec, req)
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("upgrade blocked for %s", elapsed)
	}
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	in, _ := store.Get(context.Background(), id)
	if in.Operation == nil || in.Operation.State != "preparing_backup" {
		t.Fatalf("operation = %+v, want preparing_backup", in.Operation)
	}
	waitForOperationState(t, store, id, "done")
}

func TestConcurrentUpgradeRejected(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	now := time.Now().UTC()
	_ = store.Save(context.Background(), instance{
		ID: id, Tier: "free", Image: "reg.azurecr.io/asmdb-instance:1.5.0", ContainerAppName: "db-test",
		Operation: &operation{Type: "upgrade", State: "starting", StartedAt: now, UpdatedAt: now},
	})
	api := newAPI(store, &fakeProvisioner{states: map[string]liveState{}}, testStatsConfig(), allowVerifier())
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/upgrade", nil)
	req.Header.Set("Authorization", "Bearer admin-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestStaleOperationExpires(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	old := time.Now().UTC().Add(-operationStaleAfter - time.Minute)
	_ = store.Save(context.Background(), instance{
		ID: id, Tier: "free", Image: "reg.azurecr.io/asmdb-instance:1.5.0", ContainerAppName: "db-test",
		Operation: &operation{Type: "upgrade", State: "starting", StartedAt: old, UpdatedAt: old},
	})
	api := newAPI(store, &fakeProvisioner{states: map[string]liveState{}}, testStatsConfig(), allowVerifier())
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/databases/"+id, nil)
	req.Header.Set("Authorization", "Bearer admin-token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	got, _ := store.Get(context.Background(), id)
	if got.Operation == nil || got.Operation.State != "failed" {
		t.Fatalf("operation = %+v, want failed", got.Operation)
	}
}

func TestUpgradeAuthEnforced(t *testing.T) {
	id := "db_abcdefghijklmnopqrstuvwx"
	store := newMemoryStore()
	_ = store.Save(context.Background(), instance{ID: id, Tier: "free", Image: "reg.azurecr.io/asmdb-instance:1.5.0", ContainerAppName: "db-test"})
	api := newAPI(store, &fakeProvisioner{states: map[string]liveState{}}, testStatsConfig(), allowVerifier())
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/upgrade", nil)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token status = %d body = %s", rec.Code, rec.Body.String())
	}

	verifier := &fakeAccessTokenVerifier{claims: verifiedAccessToken{Scopes: []string{entraScopeName}}}
	api = newAPI(store, &fakeProvisioner{states: map[string]liveState{}}, testStatsConfig(), verifier)
	mux = http.NewServeMux()
	api.register(mux)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/upgrade", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("missing group status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestStatsNoPlatformSecretDegrades(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "free", TokenHash: tokenHash("t"), ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	api := newAPI(store, &fakeProvisioner{states: map[string]liveState{}}, testConfig(), allowVerifier())
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/databases/"+id+"/stats", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var got statsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Available || got.Reason != "platform_token_unconfigured" {
		t.Fatalf("stats = %+v, want unavailable platform_token_unconfigured", got)
	}
}

func TestStatsStoppedInstanceIsUnavailableNotZero(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "free", TokenHash: tokenHash("t"), ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer server.Close()
	api := newStatsTestAPI(store, &fakeProvisioner{
		internalEndpoint: server.URL,
		states:           map[string]liveState{id: {State: "stopped"}},
	})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/databases/"+id+"/stats", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var got statsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Available || got.Reason != "stopped" || len(got.Stats) != 0 {
		t.Fatalf("stats = %+v, want unavailable stopped without zero stats", got)
	}
	if calls != 0 {
		t.Fatalf("stats endpoint was called %d times; stopped instances must not be cold-started", calls)
	}
}

func TestStatsUnreachableInstanceIsUnavailable(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "free", TokenHash: tokenHash("t"), ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	server.Close()
	api := newStatsTestAPI(store, &fakeProvisioner{internalEndpoint: server.URL, states: map[string]liveState{}})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/databases/"+id+"/stats", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var got statsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Available {
		t.Fatalf("stats = %+v, want unavailable", got)
	}
}

func TestStatsRequiresEntraToken(t *testing.T) {
	api := newStatsTestAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/databases/db_abcdefghijklmnopqrstuvwx/stats", nil)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestStatsRequiresAdminGroup(t *testing.T) {
	verifier := &fakeAccessTokenVerifier{claims: verifiedAccessToken{Scopes: []string{entraScopeName}}}
	api := newAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}}, testStatsConfig(), verifier)
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/databases/db_abcdefghijklmnopqrstuvwx/stats", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestWakeRouteReturnsPromptlyAndRequiresAuth(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "standard", TokenHash: tokenHash("t"), ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		writeJSON(w, http.StatusOK, healthResponse{Status: "ok", Engine: "1.5.0"})
	}))
	defer server.Close()
	api := newStatsTestAPI(store, &fakeProvisioner{
		internalEndpoint: server.URL,
		states:           map[string]liveState{id: {State: "stopped"}},
	})
	api.wakeClient = server.Client()
	api.wakeClient.Timeout = 300 * time.Millisecond
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/wake", nil)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no auth status = %d body = %s", rec.Code, rec.Body.String())
	}

	start := time.Now()
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/wake", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("wake blocked for %s; want prompt response", elapsed)
	}
	if !strings.Contains(rec.Body.String(), `"state":"stopped"`) {
		t.Fatalf("body = %s, want current stopped state", rec.Body.String())
	}
}

func TestStatsAzureColdStartIsStartingNotBroken(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "standard", TokenHash: tokenHash("t"), ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(azureColdStartHTML))
	}))
	defer server.Close()
	api := newStatsTestAPI(store, &fakeProvisioner{internalEndpoint: server.URL, states: map[string]liveState{id: {State: "running"}}})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/databases/"+id+"/stats", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var got statsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Available || got.Reason != "instance_starting" {
		t.Fatalf("stats = %+v, want instance_starting", got)
	}
}

func TestListWithStatsFetchesConcurrently(t *testing.T) {
	store := newMemoryStore()
	ids := []string{"db_abcdefghijklmnopqrstuvwx", "db_bcdefghijklmnopqrstuvwxy"}
	for _, id := range ids {
		if err := store.Save(context.Background(), instance{ID: id, Name: id, Tier: "free", CreatedAt: time.Now().UTC(), TokenHash: tokenHash("t"), ContainerAppName: containerAppName(id)}); err != nil {
			t.Fatal(err)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		writeJSON(w, http.StatusOK, map[string]any{"rows": 12, "engine": "1.6.0", "storageFormat": "2", "cpu": 0.25, "memory": 1024})
	}))
	defer server.Close()
	api := newStatsTestAPI(store, &fakeProvisioner{internalEndpoint: server.URL, states: map[string]liveState{}})
	mux := http.NewServeMux()
	api.register(mux)

	start := time.Now()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/databases?include_stats=true", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	elapsed := time.Since(start)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("stats listing took %s; fetches appear serialized", elapsed)
	}
	var got struct {
		Databases []databaseResponse `json:"databases"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Databases) != 2 {
		t.Fatalf("databases = %d, want 2", len(got.Databases))
	}
	for _, db := range got.Databases {
		if db.Stats == nil || !db.Stats.Available {
			t.Fatalf("database %s stats = %+v, want available", db.ID, db.Stats)
		}
	}
	updated, _ := store.Get(context.Background(), ids[0])
	if updated.Engine != "1.6.0" || updated.StorageFormat != "2" || updated.EngineSource != "instance" {
		t.Fatalf("stored reported version = %+v", updated)
	}
}

func TestCostUsesReplicaSeriesForActiveAndPausedHours(t *testing.T) {
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	toTime := from.Add(time.Hour)
	in := instance{ID: "db_abcdefghijklmnopqrstuvwx", Name: "db", Tier: "standard", CreatedAt: from.Add(-time.Hour), ContainerAppName: "db-test"}
	api := newStatsTestAPI(newMemoryStore(), &fakeProvisioner{
		states: map[string]liveState{in.ID: {State: "running"}},
		replicas: map[string][]replicaSample{in.ID: {
			{Average: 1},
			{Average: 0.5},
			{Average: 0},
			{Average: 1},
		}},
	})
	got := api.costForDatabase(context.Background(), in, from, toTime)
	if got.ActiveHours != 0.625 || got.PausedHours != 0.375 {
		t.Fatalf("active/paused = %v/%v, want 0.625/0.375", got.ActiveHours, got.PausedHours)
	}
	if got.EstimatedComputeUSD <= 0 {
		t.Fatalf("cost = %v, want positive", got.EstimatedComputeUSD)
	}
}

func TestPausedInstanceAccruesNoComputeCost(t *testing.T) {
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	toTime := from.Add(time.Hour)
	in := instance{ID: "db_abcdefghijklmnopqrstuvwx", Name: "db", Tier: "free", CreatedAt: from.Add(-time.Hour), ContainerAppName: "db-test"}
	api := newStatsTestAPI(newMemoryStore(), &fakeProvisioner{
		states:   map[string]liveState{in.ID: {State: "stopped"}},
		replicas: map[string][]replicaSample{in.ID: {{Average: 0}, {Average: 0}, {Average: 0}, {Average: 0}}},
	})
	got := api.costForDatabase(context.Background(), in, from, toTime)
	if got.ActiveHours != 0 || got.EstimatedComputeUSD != 0 {
		t.Fatalf("active/cost = %v/%v, want zero", got.ActiveHours, got.EstimatedComputeUSD)
	}
}

func TestCostRatesMatchDocs(t *testing.T) {
	if containerAppsVCPUActiveUSDPerSecond != 0.000024 {
		t.Fatalf("active vCPU rate drifted: %v", containerAppsVCPUActiveUSDPerSecond)
	}
	if containerAppsVCPUIDLEUSDPerSecond != 0.000003 {
		t.Fatalf("idle vCPU rate drifted: %v", containerAppsVCPUIDLEUSDPerSecond)
	}
	if containerAppsMemoryUSDPerGiBSecond != 0.000003 {
		t.Fatalf("memory rate drifted: %v", containerAppsMemoryUSDPerGiBSecond)
	}
}

func TestCostFlagsWindowPredatingInstance(t *testing.T) {
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	toTime := from.Add(24 * time.Hour)
	in := instance{ID: "db_abcdefghijklmnopqrstuvwx", Name: "db", Tier: "free", CreatedAt: from.Add(23 * time.Hour), ContainerAppName: "db-test"}
	api := newStatsTestAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}})
	got := api.costForDatabase(context.Background(), in, from, toTime)
	if !got.WindowPredatesInstance {
		t.Fatal("expected windowPredatesInstance")
	}
	if got.PausedHours != 1 {
		t.Fatalf("paused hours = %v, want only post-create window", got.PausedHours)
	}
}

func TestCostsAuthEnforced(t *testing.T) {
	api := newStatsTestAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/costs", nil)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token status = %d body = %s", rec.Code, rec.Body.String())
	}

	verifier := &fakeAccessTokenVerifier{claims: verifiedAccessToken{Scopes: []string{entraScopeName}}}
	api = newAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}}, testStatsConfig(), verifier)
	mux = http.NewServeMux()
	api.register(mux)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/costs", nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("missing group status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestExecValidTokenProxies(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	token := "customer-token"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "free", TokenHash: tokenHash(token), ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}

	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/exec" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+token {
			t.Fatalf("authorization = %q", got)
		}
		var req execRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		if req.Command != "SELECT *" {
			t.Fatalf("command = %q", req.Command)
		}
		writeJSON(w, http.StatusOK, execResponse{Output: []string{"row"}, OK: true})
	}))
	defer server.Close()

	api := newTestAPI(store, &fakeProvisioner{
		endpoint:         "https://public.example.test/db/abcdefghijklmnopqrstuvwx",
		internalEndpoint: server.URL,
		states:           map[string]liveState{},
	})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/exec", bytes.NewBufferString(`{"command":"SELECT *"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
	var got execResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.OK || len(got.Output) != 1 || got.Output[0] != "row" {
		t.Fatalf("response = %+v", got)
	}
}

func TestExecRetriesAzureColdStartHTML(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	token := "customer-token"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "standard", TokenHash: tokenHash(token), ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(azureColdStartHTML))
			return
		}
		writeJSON(w, http.StatusOK, execResponse{Output: []string{"awake"}, OK: true})
	}))
	defer server.Close()

	api := newStatsTestAPI(store, &fakeProvisioner{internalEndpoint: server.URL, states: map[string]liveState{}})
	api.execRetryBackoff = 5 * time.Millisecond
	api.execRetryBudget = 100 * time.Millisecond
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/exec", bytes.NewBufferString(`{"command":"SELECT *"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3 retries through cold start", calls)
	}
}

func TestExecColdStartBudgetExhaustedUsesSpecificError(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	token := "customer-token"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "standard", TokenHash: tokenHash(token), ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(azureColdStartHTML))
	}))
	defer server.Close()

	api := newStatsTestAPI(store, &fakeProvisioner{internalEndpoint: server.URL, states: map[string]liveState{}})
	api.execRetryBackoff = 5 * time.Millisecond
	api.execRetryBudget = 20 * time.Millisecond
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/exec", bytes.NewBufferString(`{"command":"SELECT *"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	codeAndDetail := decodeErrorCode(t, rec.Body)
	if !strings.HasPrefix(codeAndDetail, "instance_starting|") {
		t.Fatalf("error = %q, want instance_starting", codeAndDetail)
	}
	if strings.Contains(codeAndDetail, "<html") || strings.Contains(codeAndDetail, "Container App - Unavailable") {
		t.Fatalf("detail leaked raw HTML: %q", codeAndDetail)
	}
}

func TestExecDoesNotRetrySidecar500(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	token := "customer-token"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "standard", TokenHash: tokenHash(token), ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		writeError(w, http.StatusInternalServerError, "internal", "engine failed", "")
	}))
	defer server.Close()

	api := newStatsTestAPI(store, &fakeProvisioner{internalEndpoint: server.URL, states: map[string]liveState{}})
	api.execRetryBackoff = 5 * time.Millisecond
	api.execRetryBudget = 100 * time.Millisecond
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/exec", bytes.NewBufferString(`{"command":"SELECT *"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want no retry for sidecar 500", calls)
	}
}

func TestExecRejectsTooLargeUpstreamResponse(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	token := "customer-token"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "standard", TokenHash: tokenHash(token), ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(bytes.Repeat([]byte("x"), maxUpstreamBodyBytes+1))
	}))
	defer server.Close()

	api := newStatsTestAPI(store, &fakeProvisioner{internalEndpoint: server.URL, states: map[string]liveState{}})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/exec", bytes.NewBufferString(`{"command":"SELECT *"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if codeAndDetail := decodeErrorCode(t, rec.Body); !strings.Contains(codeAndDetail, "response too large") {
		t.Fatalf("error = %q, want explicit response too large", codeAndDetail)
	}
}

func TestExecWrongTokenGets401WithoutOutboundCall(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "free", TokenHash: tokenHash("right"), ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer server.Close()

	api := newTestAPI(store, &fakeProvisioner{internalEndpoint: server.URL, states: map[string]liveState{}})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/exec", bytes.NewBufferString(`{"command":"SELECT *"}`))
	req.Header.Set("Authorization", "Bearer wrong")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if calls != 0 {
		t.Fatalf("outbound calls = %d, want 0", calls)
	}
}

func TestExecUnknownIDGets404(t *testing.T) {
	api := newTestAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/db_abcdefghijklmnopqrstuvwx/exec", bytes.NewBufferString(`{"command":"SELECT *"}`))
	req.Header.Set("Authorization", "Bearer token")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestExecNonJSONFromInstanceGets502(t *testing.T) {
	store := newMemoryStore()
	id := "db_abcdefghijklmnopqrstuvwx"
	token := "customer-token"
	if err := store.Save(context.Background(), instance{ID: id, Tier: "free", TokenHash: tokenHash(token), ContainerAppName: "db-test"}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("not json"))
	}))
	defer server.Close()

	api := newTestAPI(store, &fakeProvisioner{internalEndpoint: server.URL, states: map[string]liveState{}})
	mux := http.NewServeMux()
	api.register(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases/"+id+"/exec", bytes.NewBufferString(`{"command":"SELECT *"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}
