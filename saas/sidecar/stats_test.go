package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestStatsReturnsRowsCapacityAndStringNumbers(t *testing.T) {
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	restore := withCgroupRoot(t, t.TempDir())
	defer restore()

	app := &api{engine: e, token: "instance", started: time.Now().Add(-5 * time.Second)}
	rec := requestStats(t, app, "instance")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if got, ok := body["rows"].(string); !ok || got != "1" {
		t.Fatalf("rows = %#v, want string %q", body["rows"], "1")
	}
	if got, ok := body["capacity"].(string); !ok || got != strconv.FormatUint(rowCapacity, 10) {
		t.Fatalf("capacity = %#v, want string %q", body["capacity"], strconv.FormatUint(rowCapacity, 10))
	}
	if got := body["engine"]; got != engineVersion {
		t.Fatalf("engine = %#v, want %q", got, engineVersion)
	}
	if _, ok := body["memory"]; ok {
		t.Fatalf("memory present with missing cgroup files: %#v", body["memory"])
	}
	if _, ok := body["cpu"]; ok {
		t.Fatalf("cpu present with missing cgroup files: %#v", body["cpu"])
	}
}

func TestStorageReportsAllocatedSparseData(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "main.dat")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	const apparent = int64(1 << 30)
	if err := makeSparseFile(f); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Truncate(apparent); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	st := collectStorageStats(dir, "main")
	if st.DataBytes == strconv.FormatInt(apparent, 10) {
		t.Fatalf("dataBytes reported apparent sparse size %s", st.DataBytes)
	}
	got, err := strconv.ParseUint(st.DataBytes, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	if got >= uint64(apparent) {
		t.Fatalf("dataBytes = %d, want allocated size less than apparent %d", got, apparent)
	}
}

func TestMemoryMaxLiteralMaxOmitsLimit(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "memory.current"), []byte("123\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "memory.max"), []byte("max\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	restore := withCgroupRoot(t, root)
	defer restore()

	mem := collectMemoryStats()
	if mem == nil {
		t.Fatal("memory stats omitted")
	}
	if mem.UsedBytes != "123" {
		t.Fatalf("usedBytes = %q, want 123", mem.UsedBytes)
	}
	if mem.LimitBytes != "" {
		t.Fatalf("limitBytes = %q, want omitted", mem.LimitBytes)
	}
	b, err := json.Marshal(statsResponse{Memory: mem})
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(b, &body); err != nil {
		t.Fatal(err)
	}
	limit, ok := body["memory"].(map[string]any)["limitBytes"]
	if ok {
		t.Fatalf("limitBytes serialized for memory.max=max: %#v", limit)
	}
}

func TestPlatformTokenWorksOnlyForStats(t *testing.T) {
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	restore := withCgroupRoot(t, t.TempDir())
	defer restore()

	app := &api{engine: e, token: "instance", platformToken: "platform", started: time.Now()}
	if rec := requestStats(t, app, "platform"); rec.Code != http.StatusOK {
		t.Fatalf("platform stats status = %d, body = %s", rec.Code, rec.Body.String())
	}

	execReq := httptest.NewRequest(http.MethodPost, "/v1/exec", stringsReader(`{"command":"COUNT"}`))
	execReq.Header.Set("Authorization", "Bearer platform")
	execReq.Header.Set("Content-Type", "application/json")
	execRec := httptest.NewRecorder()
	app.routes().ServeHTTP(execRec, execReq)
	if execRec.Code != http.StatusUnauthorized {
		t.Fatalf("platform token accepted on exec: status = %d", execRec.Code)
	}

	insertReq := httptest.NewRequest(http.MethodPost, "/v1/rows", stringsReader(`{"id":"1","value":"1","tag":"t","content":"c"}`))
	insertReq.Header.Set("Authorization", "Bearer platform")
	insertReq.Header.Set("Content-Type", "application/json")
	insertRec := httptest.NewRecorder()
	app.routes().ServeHTTP(insertRec, insertReq)
	if insertRec.Code != http.StatusUnauthorized {
		t.Fatalf("platform token accepted on insert: status = %d", insertRec.Code)
	}
}

func TestNoTokenRejectedForStats(t *testing.T) {
	app := &api{token: "instance", platformToken: "platform"}
	req := httptest.NewRequest(http.MethodGet, "/v1/stats", nil)
	rec := httptest.NewRecorder()
	app.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func requestStats(t *testing.T, app *api, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/stats", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	app.routes().ServeHTTP(rec, req)
	return rec
}

func withCgroupRoot(t *testing.T, root string) func() {
	t.Helper()
	old := cgroupRoot
	cgroupRoot = root
	return func() { cgroupRoot = old }
}

func stringsReader(s string) *strings.Reader {
	return strings.NewReader(s)
}
