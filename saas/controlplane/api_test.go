package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type fakeProvisioner struct {
	created []instance
	states  map[string]liveState
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
	return "https://" + in.ContainerAppName + ".example.test"
}

func TestValidName(t *testing.T) {
	valid := []string{"my-notes", "a1", "abc123", "a-b-c", "a2345678901234567890123456789012345678z"}
	for _, name := range valid {
		if !validName(name) {
			t.Fatalf("expected valid name %q", name)
		}
	}
	invalid := []string{"", "a", "-abc", "abc-", "ABC", "a_b", "a..b", "a23456789012345678901234567890123456789z"}
	for _, name := range invalid {
		if validName(name) {
			t.Fatalf("expected invalid name %q", name)
		}
	}
}

func TestCreateDatabaseAndTokenOnlyOnce(t *testing.T) {
	store := newMemoryStore()
	prov := &fakeProvisioner{states: map[string]liveState{}}
	api := newAPI(store, prov, "")
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
	api := newAPI(store, &fakeProvisioner{states: map[string]liveState{}}, "")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases", bytes.NewBufferString(`{"name":"another","tier":"free"}`))
	api.createDatabase(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestAdminKeyForPostAndDelete(t *testing.T) {
	api := newAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}}, "secret")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/databases", bytes.NewBufferString(`{"name":"my-notes","tier":"free"}`))
	api.createDatabase(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}
