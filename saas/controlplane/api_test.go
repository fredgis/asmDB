package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

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

func (p *fakeProvisioner) RotateToken(_ context.Context, _ instance, token string) error {
	if p.rotateErr != nil {
		return p.rotateErr
	}
	p.rotated = append(p.rotated, token)
	return nil
}

func (p *fakeProvisioner) UpgradeImage(_ context.Context, _ instance, image string) error {
	if p.upgradeErr != nil {
		return p.upgradeErr
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

func newTestAPI(store store, prov provisioner) *api {
	return newAPI(store, prov, testConfig(), allowVerifier())
}

func newStatsTestAPI(store store, prov provisioner) *api {
	return newAPI(store, prov, testStatsConfig(), allowVerifier())
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
		wantEngine       string
		wantAvailableImg string
	}{
		{
			name:             "equal tags",
			recorded:         "reg.azurecr.io/asmdb-instance:1.5.0",
			current:          "reg.azurecr.io/asmdb-instance:1.5.0",
			wantEngine:       "1.5.0",
			wantAvailableImg: "reg.azurecr.io/asmdb-instance:1.5.0",
		},
		{
			name:             "different tags",
			recorded:         "reg.azurecr.io/asmdb-instance:1.5.0",
			current:          "reg.azurecr.io/asmdb-instance:1.5.1",
			wantAvailable:    true,
			wantEngine:       "1.5.1",
			wantAvailableImg: "reg.azurecr.io/asmdb-instance:1.5.1",
		},
		{
			name:             "recorded missing tag cannot tell",
			recorded:         "reg.azurecr.io/asmdb-instance",
			current:          "reg.azurecr.io/asmdb-instance:1.5.1",
			wantEngine:       "1.5.1",
			wantAvailableImg: "reg.azurecr.io/asmdb-instance:1.5.1",
		},
		{
			name:     "current missing tag cannot tell",
			recorded: "reg.azurecr.io/asmdb-instance:1.5.0",
			current:  "reg.azurecr.io/asmdb-instance",
		},
		{
			name:     "digest current cannot tell",
			recorded: "reg.azurecr.io/asmdb-instance:1.5.0",
			current:  "reg.azurecr.io/asmdb-instance@sha256:abc",
		},
		{
			name:     "empty current cannot tell",
			recorded: "reg.azurecr.io/asmdb-instance:1.5.0",
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
				Engine:           "1.5.0",
				CreatedAt:        time.Now().UTC(),
				ContainerAppName: "db-test",
			})
			if got.UpgradeAvailable != tt.wantAvailable || got.AvailableEngine != tt.wantEngine || got.AvailableImage != tt.wantAvailableImg {
				t.Fatalf("response = %+v, want available=%v engine=%q image=%q", got, tt.wantAvailable, tt.wantEngine, tt.wantAvailableImg)
			}
		})
	}
}

func TestRotateTokenChangesStoredHashAndReturnsTokenOnce(t *testing.T) {
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
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}

	var rotated rotateTokenResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &rotated); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(rotated.Token) {
		t.Fatalf("unexpected token shape: %q", rotated.Token)
	}
	if len(prov.rotated) != 1 || prov.rotated[0] != rotated.Token {
		t.Fatalf("pushed tokens = %#v, want returned token", prov.rotated)
	}
	updated, err := store.Get(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if updated.TokenHash == oldHash {
		t.Fatal("stored hash did not change")
	}
	if updated.TokenHash == rotated.Token {
		t.Fatal("store contains plaintext token")
	}
	if updated.TokenHash != tokenHash(rotated.Token) {
		t.Fatal("store does not contain returned token hash")
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/databases/"+id, nil)
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d body = %s", rec.Code, rec.Body.String())
	}
	var got databaseResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Token != "" {
		t.Fatal("GET returned rotated token")
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

func TestRotateTokenPushFailureRestoresOldHash(t *testing.T) {
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
	req.Header.Set("Authorization", "Bearer admin")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	got, err := store.Get(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if got.TokenHash != oldHash {
		t.Fatalf("hash = %q, want old hash restored", got.TokenHash)
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
		writeJSON(w, http.StatusOK, execResponse{Output: []string{"[ERR] backup failed"}, OK: false})
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
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if len(prov.upgraded) != 0 {
		t.Fatalf("upgrade called after backup failure: %#v", prov.upgraded)
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
		writeJSON(w, http.StatusOK, execResponse{Output: []string{"backup ok"}, OK: true})
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
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
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
		if r.URL.Path == "/v1/exec" {
			backupCalls++
			writeJSON(w, http.StatusOK, execResponse{Output: []string{"backup ok"}, OK: true})
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
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if backupCalls != 1 || len(prov.upgraded) != 1 {
		t.Fatalf("backupCalls=%d upgraded=%#v, want one backup and one upgrade", backupCalls, prov.upgraded)
	}
	if !strings.Contains(rec.Body.String(), "was stopped") {
		t.Fatalf("response does not explain stopped upgrade: %s", rec.Body.String())
	}
	got, _ := store.Get(context.Background(), id)
	if got.Image != testStatsConfig().Image || got.Engine != "1.6.0" {
		t.Fatalf("stored instance = %+v", got)
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
	api := newTestAPI(store, &fakeProvisioner{states: map[string]liveState{}})
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
		writeJSON(w, http.StatusOK, map[string]any{"rows": 12, "cpu": 0.25, "memory": 1024})
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
