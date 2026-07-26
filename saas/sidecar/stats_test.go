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
	t.Setenv("ASMDB_FAKE_RAW_CAPACITY", "4194304")
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
	if got, ok := body["capacity"].(string); !ok || got != "3145728" {
		t.Fatalf("capacity = %#v, want string %q", body["capacity"], "3145728")
	}
	if got := body["engine"]; got != "9.8.7" {
		t.Fatalf("engine = %#v, want %q", got, "9.8.7")
	}
	if got := body["storageFormat"]; got != "42" {
		t.Fatalf("storageFormat = %#v, want %q", got, "42")
	}
	if _, ok := body["memory"]; ok {
		t.Fatalf("memory present with missing cgroup files: %#v", body["memory"])
	}
	if _, ok := body["cpu"]; ok {
		t.Fatalf("cpu present with missing cgroup files: %#v", body["cpu"])
	}
}

func TestStatsCapacityComesFromEngineRawSlotsAsUsableRows(t *testing.T) {
	t.Setenv("ASMDB_FAKE_RAW_CAPACITY", "2097152")
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	restore := withCgroupRoot(t, t.TempDir())
	defer restore()

	app := &api{engine: e, token: "instance", started: time.Now()}
	rec := requestStats(t, app, "instance")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if got, ok := body["capacity"].(string); !ok || got != "1572864" {
		t.Fatalf("capacity = %#v, want usable rows %q", body["capacity"], "1572864")
	}
}

func TestStatsSmallCapacityDatabaseReportsSmallUsableRows(t *testing.T) {
	t.Setenv("ASMDB_FAKE_RAW_CAPACITY", "524288")
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	restore := withCgroupRoot(t, t.TempDir())
	defer restore()

	app := &api{engine: e, token: "instance", started: time.Now()}
	rec := requestStats(t, app, "instance")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if got, ok := body["capacity"].(string); !ok || got != "393216" {
		t.Fatalf("capacity = %#v, want usable rows %q", body["capacity"], "393216")
	}
}

func TestStatsUnknownCapacityDoesNotDefaultToPremium(t *testing.T) {
	t.Setenv("ASMDB_FAKE_CAPACITY_MODE", "missing")
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	restore := withCgroupRoot(t, t.TempDir())
	defer restore()

	app := &api{engine: e, token: "instance", started: time.Now()}
	rec := requestStats(t, app, "instance")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if _, ok := body["capacity"]; ok {
		t.Fatalf("capacity present for unknown engine capacity: %#v", body["capacity"])
	}
}

func TestStatsDuringEngineWorkReturnsTransientCachedSample(t *testing.T) {
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	restore := withCgroupRoot(t, t.TempDir())
	defer restore()

	app := &api{engine: e, token: "instance", started: time.Now().Add(-5 * time.Second)}
	first := requestStats(t, app, "instance")
	if first.Code != http.StatusOK {
		t.Fatalf("initial stats status = %d, body = %s", first.Code, first.Body.String())
	}
	app.statsMu.Lock()
	app.statsAt = time.Now().Add(-statsTTL - time.Second)
	app.statsMu.Unlock()

	gen := e.generation()
	e.cmdMu.Lock()
	busy := requestStats(t, app, "instance")
	e.cmdMu.Unlock()
	if busy.Code != http.StatusOK {
		t.Fatalf("busy stats status = %d, body = %s", busy.Code, busy.Body.String())
	}
	if got := e.generation(); got != gen {
		t.Fatalf("stats probe changed generation = %d, want %d", got, gen)
	}
	var body map[string]any
	if err := json.Unmarshal(busy.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "busy" || body["transient"] != true || body["stale"] != true {
		t.Fatalf("busy stats state = %#v", body)
	}
	if body["rows"] != "1" {
		t.Fatalf("busy stats rows = %#v, want cached rows", body["rows"])
	}
}

func TestStatsBusyAndPermanentUnavailableAreDistinguishable(t *testing.T) {
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	restore := withCgroupRoot(t, t.TempDir())
	defer restore()

	app := &api{engine: e, token: "instance", started: time.Now()}
	e.cmdMu.Lock()
	busy := requestStats(t, app, "instance")
	e.cmdMu.Unlock()
	if busy.Code != http.StatusOK {
		t.Fatalf("busy stats status = %d, body = %s", busy.Code, busy.Body.String())
	}
	var busyBody map[string]any
	if err := json.Unmarshal(busy.Body.Bytes(), &busyBody); err != nil {
		t.Fatal(err)
	}
	if busyBody["status"] != "busy" || busyBody["transient"] != true {
		t.Fatalf("busy stats body = %#v", busyBody)
	}

	bin := writeFakeEngineLauncher(t)
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "main.dat"), "LOCK")
	restoreTimings := withEngineTimings(t, 10*time.Millisecond, 10*time.Millisecond, 10*time.Millisecond, 10*time.Millisecond, 1)
	defer restoreTimings()
	dead := &Engine{bin: bin, data: dir, name: "main", info: unknownEngineInfo}
	deadApp := &api{engine: dead, token: "instance", started: time.Now()}
	permanent := requestStats(t, deadApp, "instance")
	if permanent.Code == http.StatusOK {
		t.Fatalf("permanent stats status = 200, want error; body = %s", permanent.Body.String())
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

	st := collectStorageStats(dir, "main", 5, true)
	if st.DataApparentBytes != strconv.FormatInt(apparent, 10) {
		t.Fatalf("dataApparentBytes = %s, want %d", st.DataApparentBytes, apparent)
	}
	got, err := strconv.ParseUint(st.DataAllocatedBytes, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	if got >= uint64(apparent) {
		t.Skipf("filesystem does not report sparse allocation: allocated=%d apparent=%d", got, apparent)
	}
	if st.DataBytes != st.DataAllocatedBytes {
		t.Fatalf("compat dataBytes = %q, want dataAllocatedBytes %q", st.DataBytes, st.DataAllocatedBytes)
	}
	if st.DataUsedBytes != strconv.FormatUint(dataUsedBytes(5), 10) {
		t.Fatalf("dataUsedBytes = %q, want header + 5 records", st.DataUsedBytes)
	}
}

func TestStatsEndpointReportsAllocatedAndApparentStorage(t *testing.T) {
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	restore := withCgroupRoot(t, t.TempDir())
	defer restore()

	path := filepath.Join(e.data, e.name+".dat")
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

	app := &api{engine: e, token: "instance", started: time.Now()}
	rec := requestStats(t, app, "instance")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Storage storageStats `json:"storage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Storage.DataApparentBytes != strconv.FormatInt(apparent, 10) {
		t.Fatalf("dataApparentBytes = %s, want %d", body.Storage.DataApparentBytes, apparent)
	}
	if body.Storage.DataReservedBytes != body.Storage.DataAllocatedBytes {
		t.Fatalf("dataReservedBytes = %q, want allocated %q", body.Storage.DataReservedBytes, body.Storage.DataAllocatedBytes)
	}
	if body.Storage.DataUsedBytes != strconv.FormatUint(dataUsedBytes(1), 10) {
		t.Fatalf("dataUsedBytes = %q, want one-row logical use", body.Storage.DataUsedBytes)
	}
	allocated, err := strconv.ParseUint(body.Storage.DataAllocatedBytes, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	if allocated >= uint64(apparent) {
		t.Skipf("filesystem does not report sparse allocation: allocated=%d apparent=%d", allocated, apparent)
	}
}

func TestStatsEndpointReportsMemoryReservationFromEngineSlots(t *testing.T) {
	t.Setenv("ASMDB_FAKE_RAW_CAPACITY", "524288")
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "memory.current"), []byte("1000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "memory.stat"), []byte("anon 300\nfile 700\ninactive_file 600\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	restore := withCgroupRoot(t, root)
	defer restore()

	app := &api{engine: e, token: "instance", started: time.Now()}
	rec := requestStats(t, app, "instance")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Memory *memoryStats `json:"memory"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Memory == nil {
		t.Fatal("memory stats omitted")
	}
	if body.Memory.ReservedBytes != "134217728" {
		t.Fatalf("reservedBytes = %q, want raw slots * 256", body.Memory.ReservedBytes)
	}
	if body.Memory.NonReclaimableBytes != "300" || body.Memory.ActualUsedBytes != "300" || body.Memory.WorkingSetBytes != "400" {
		t.Fatalf("memory use = %#v, want anon actual use and current - inactive_file working set", body.Memory)
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

	mem := collectMemoryStats(0)
	if mem == nil {
		t.Fatal("memory stats omitted")
	}
	if mem.CurrentBytes != "123" {
		t.Fatalf("currentBytes = %q, want 123", mem.CurrentBytes)
	}
	if mem.UsedBytes != "" {
		t.Fatalf("usedBytes = %q, want omitted without anon memory.stat", mem.UsedBytes)
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

func TestMemoryWorkingSetSubtractsReclaimableFileCache(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "memory.current"), []byte("1000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "memory.max"), []byte("2000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "memory.stat"), []byte("file 700\ninactive_file 600\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "memory.events"), []byte("low 0\nhigh 2\nmax 0\noom 0\noom_kill 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "memory.pressure"), []byte("some avg10=0.00 avg60=0.00 avg300=0.00 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	restore := withCgroupRoot(t, root)
	defer restore()

	mem := collectMemoryStats(0)
	if mem == nil {
		t.Fatal("memory stats omitted")
	}
	if mem.CurrentBytes != "1000" || mem.UsedBytes != "" || mem.ReclaimableBytes != "600" || mem.WorkingSetBytes != "400" {
		t.Fatalf("memory = %#v, want current=1000 used omitted reclaimable=600 workingSet=400", mem)
	}
	if mem.FileBytes != "700" || mem.InactiveFileBytes != "600" {
		t.Fatalf("file cache fields = %#v", mem)
	}
	if mem.Events["high"] != "2" {
		t.Fatalf("events = %#v, want high=2", mem.Events)
	}
	if mem.Pressure["some"]["total"] != "123" {
		t.Fatalf("pressure = %#v, want some.total=123", mem.Pressure)
	}
}

func TestMemoryReservationAndNonReclaimableWhenFileCacheDominates(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "memory.current"), []byte("1073741824\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stat := strings.Join([]string{
		"anon 65536",
		"file 1073676288",
		"inactive_file 1073600000",
		"kernel 32768",
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(root, "memory.stat"), []byte(stat), 0o600); err != nil {
		t.Fatal(err)
	}
	restore := withCgroupRoot(t, root)
	defer restore()

	mem := collectMemoryStats(1073741824)
	if mem == nil {
		t.Fatal("memory stats omitted")
	}
	if mem.ReservedBytes != "1073741824" {
		t.Fatalf("reservedBytes = %q, want slot reservation", mem.ReservedBytes)
	}
	if mem.AnonymousBytes != "65536" || mem.FileBytes != "1073676288" || mem.ReclaimableBytes != "1073600000" {
		t.Fatalf("memory split = %#v", mem)
	}
	if mem.ActualUsedBytes != "65536" || mem.NonReclaimableBytes != "65536" || mem.UsedBytes != "65536" || mem.WorkingSetBytes != "141824" {
		t.Fatalf("memory use = %#v, want anon actual use 65536 and working set 141824", mem)
	}
}

func TestMemoryReservationAndNonReclaimableWhenAnonDominates(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "memory.current"), []byte("2000000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stat := strings.Join([]string{
		"anon 1500000",
		"file 300000",
		"inactive_file 100000",
		"kernel 200000",
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(root, "memory.stat"), []byte(stat), 0o600); err != nil {
		t.Fatal(err)
	}
	restore := withCgroupRoot(t, root)
	defer restore()

	mem := collectMemoryStats(1073741824)
	if mem == nil {
		t.Fatal("memory stats omitted")
	}
	if mem.AnonymousBytes != "1500000" || mem.FileBytes != "300000" || mem.ReclaimableBytes != "100000" {
		t.Fatalf("memory split = %#v", mem)
	}
	if mem.ActualUsedBytes != "1500000" || mem.NonReclaimableBytes != "1500000" || mem.UsedBytes != "1500000" || mem.WorkingSetBytes != "1900000" {
		t.Fatalf("memory use = %#v, want anon actual use 1500000 and working set 1900000", mem)
	}
}

func TestMemoryStatsUseCgroupV1Fallback(t *testing.T) {
	root := t.TempDir()
	memoryDir := filepath.Join(root, "memory")
	if err := os.MkdirAll(memoryDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(memoryDir, "memory.usage_in_bytes"), []byte("2000000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stat := strings.Join([]string{
		"total_rss 700000",
		"total_cache 1200000",
		"total_inactive_file 900000",
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(memoryDir, "memory.stat"), []byte(stat), 0o600); err != nil {
		t.Fatal(err)
	}
	restore := withCgroupRoot(t, root)
	defer restore()

	mem := collectMemoryStats(0)
	if mem == nil {
		t.Fatal("memory stats omitted")
	}
	if mem.CurrentBytes != "2000000" || mem.UsedBytes != "700000" || mem.ActualUsedBytes != "700000" {
		t.Fatalf("v1 current/used = %#v", mem)
	}
	if mem.FileBytes != "1200000" || mem.ReclaimableBytes != "900000" || mem.InactiveFileBytes != "900000" {
		t.Fatalf("v1 file cache = %#v", mem)
	}
	if mem.WorkingSetBytes != "1100000" {
		t.Fatalf("v1 workingSetBytes = %q, want 1100000", mem.WorkingSetBytes)
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
	setBearer(req, token)
	rec := httptest.NewRecorder()
	app.routes().ServeHTTP(rec, req)
	return rec
}

func setBearer(req *http.Request, token string) {
	req.Header.Set("Authorization", strings.Join([]string{"Bearer", token}, " "))
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
