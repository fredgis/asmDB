package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeProvisioner struct {
	created  []instance
	endpoint string
	states   map[string]liveState
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

func (p *fakeProvisioner) Endpoint(in instance) string {
	if p.endpoint != "" {
		return p.endpoint
	}
	return "https://" + in.ContainerAppName + ".example.test"
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
	clientID := "3e607c6e-811b-47e6-b9b1-9bbe11812596"
	return config{
		EntraTenantID: "<tenant-id>",
		EntraClientID: clientID,
		EntraGroupID:  "<admin-group-id>",
		EntraScope:    "api://" + clientID + "/" + entraScopeName,
	}
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
	api := newTestAPI(store, prov)
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

	api := newTestAPI(store, &fakeProvisioner{endpoint: server.URL, states: map[string]liveState{}})
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

	api := newTestAPI(store, &fakeProvisioner{endpoint: server.URL, states: map[string]liveState{}})
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

	api := newTestAPI(store, &fakeProvisioner{endpoint: server.URL, states: map[string]liveState{}})
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
