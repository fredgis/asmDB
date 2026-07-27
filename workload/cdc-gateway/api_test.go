package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestNewAppRefusesWritableShare(t *testing.T) {
	_, err := newApp(config{ShareRoot: t.TempDir(), Token: "token"}, func(string) error {
		return errors.New("ASMDB_SHARE_ROOT must be mounted read-only")
	})
	if err == nil {
		t.Fatal("newApp succeeded with writable share")
	}
}

func TestCleanLogPagedEndToEndAndLimitCapped(t *testing.T) {
	app, root := testApp(t)
	writeInstance(t, root, "db1", fixtureLog(0,
		frameFixture(1, 0, upsertFixture(1)),
		frameFixture(2, 0, deleteFixture(1)),
		frameFixture(3, 0, upsertFixture(3)),
	))
	first := getCDC(t, app, "db1", "from=0&limit=2", "token")
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d body=%s", first.Code, first.Body.String())
	}
	if got := first.Header().Get("X-Asmdb-Has-More"); got != "true" {
		t.Fatalf("has-more = %q, want true", got)
	}
	if lines := ndjsonLines(first); len(lines) != 2 {
		t.Fatalf("first page lines = %d, want 2", len(lines))
	}
	second := getCDC(t, app, "db1", "from=2&limit=999999", "token")
	if second.Code != http.StatusOK {
		t.Fatalf("second status = %d body=%s", second.Code, second.Body.String())
	}
	if got := second.Header().Get("X-Asmdb-Has-More"); got != "false" {
		t.Fatalf("has-more = %q, want false", got)
	}
	if lines := ndjsonLines(second); len(lines) != 1 {
		t.Fatalf("second page lines = %d, want 1", len(lines))
	}
	many := make([][]byte, 0, maxLimit+1)
	for i := 1; i <= maxLimit+1; i++ {
		many = append(many, frameFixture(uint64(i), 0, upsertFixture(uint64(i))))
	}
	writeInstance(t, root, "capdb", fixtureLog(0, many...))
	capRec := getCDC(t, app, "capdb", "from=0&limit=999999", "token")
	if capRec.Code != http.StatusOK {
		t.Fatalf("cap status = %d body=%s", capRec.Code, capRec.Body.String())
	}
	if lines := ndjsonLines(capRec); len(lines) != maxLimit {
		t.Fatalf("cap lines = %d, want %d", len(lines), maxLimit)
	}
	if got := capRec.Header().Get("X-Asmdb-Has-More"); got != "true" {
		t.Fatalf("cap has-more = %q, want true", got)
	}
}

func TestTrimmedPastRequestedSequenceIsGap(t *testing.T) {
	app, root := testApp(t)
	writeInstance(t, root, "db1", fixtureLog(5000, frameFixture(5001, 0, upsertFixture(1))))
	rec := getCDC(t, app, "db1", "from=120&limit=10", "token")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"]["code"] != "cdc_gap" || body["error"]["baseSeq"] != "5000" {
		t.Fatalf("gap body = %#v", body)
	}
}

func TestTrimBetweenPagesIsGap(t *testing.T) {
	app, root := testApp(t)
	writeInstance(t, root, "db1", fixtureLog(0, frameFixture(1, 0, upsertFixture(1)), frameFixture(2, 0, upsertFixture(2))))
	first := getCDC(t, app, "db1", "from=0&limit=1", "token")
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d body=%s", first.Code, first.Body.String())
	}
	writeInstance(t, root, "db1", fixtureLog(2, frameFixture(3, 0, upsertFixture(3))))
	second := getCDC(t, app, "db1", "from=1&limit=1", "token")
	if second.Code != http.StatusConflict {
		t.Fatalf("second status = %d body=%s", second.Code, second.Body.String())
	}
}

func TestTornTailServesLastCompleteFrame(t *testing.T) {
	app, root := testApp(t)
	data := fixtureLog(0, frameFixture(1, 0, upsertFixture(1)))
	data = append(data, frameFixture(2, 0, upsertFixture(2))[:24]...)
	writeInstance(t, root, "db1", data)
	rec := getCDC(t, app, "db1", "from=0&limit=10", "token")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if lines := ndjsonLines(rec); len(lines) != 1 {
		t.Fatalf("lines = %d, want 1", len(lines))
	}
}

func TestCorruptCRCIsErrorNotSilence(t *testing.T) {
	app, root := testApp(t)
	data := fixtureLog(10, frameFixture(11, 0, upsertFixture(1)), frameFixture(12, 0, upsertFixture(2)))
	data[len(data)-16] ^= 0xff
	writeInstance(t, root, "db1", data)
	rec := getCDC(t, app, "db1", "from=10&limit=10", "token")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	errBody := body["error"]
	if errBody["code"] != "cdc_corrupt" {
		t.Fatalf("code = %q, want cdc_corrupt; body=%#v", errBody["code"], body)
	}
	if errBody["baseSeq"] != "10" || errBody["lastSeq"] != "11" || errBody["commitSeq"] != "12" {
		t.Fatalf("corrupt position fields = %#v", errBody)
	}
}

func TestCorruptAndGapAreDistinctConflictErrors(t *testing.T) {
	app, root := testApp(t)
	writeInstance(t, root, "gapdb", fixtureLog(5000, frameFixture(5001, 0, upsertFixture(1))))
	gap := getCDC(t, app, "gapdb", "from=120&limit=10", "token")
	if gap.Code != http.StatusConflict {
		t.Fatalf("gap status = %d body=%s", gap.Code, gap.Body.String())
	}

	data := fixtureLog(0, frameFixture(1, 0, upsertFixture(1)))
	data[len(data)-16] ^= 0xff
	writeInstance(t, root, "corruptdb", data)
	corrupt := getCDC(t, app, "corruptdb", "from=0&limit=10", "token")
	if corrupt.Code != http.StatusConflict {
		t.Fatalf("corrupt status = %d body=%s", corrupt.Code, corrupt.Body.String())
	}

	var gapBody, corruptBody map[string]map[string]string
	if err := json.Unmarshal(gap.Body.Bytes(), &gapBody); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(corrupt.Body.Bytes(), &corruptBody); err != nil {
		t.Fatal(err)
	}
	if gapBody["error"]["code"] != "cdc_gap" || corruptBody["error"]["code"] != "cdc_corrupt" {
		t.Fatalf("codes not distinct: gap=%#v corrupt=%#v", gapBody, corruptBody)
	}
}

func TestResetFrameIsReturned(t *testing.T) {
	app, root := testApp(t)
	writeInstance(t, root, "db1", fixtureLog(0, frameFixture(1, resetFlag)))
	rec := getCDC(t, app, "db1", "from=0&limit=10", "token")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"reset":true`) {
		t.Fatalf("body = %s, want reset=true", rec.Body.String())
	}
}

func TestAuthUnknownInstanceUnreadableShareAndHead(t *testing.T) {
	app, root := testApp(t)
	writeInstance(t, root, "db1", fixtureLog(7, frameFixture(8, 0, upsertFixture(1))))
	rec := getCDC(t, app, "db1", "from=7&limit=1", "bad")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token status = %d", rec.Code)
	}
	rec = getCDC(t, app, "missing", "from=0&limit=1", "token")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing status = %d body=%s", rec.Code, rec.Body.String())
	}
	head := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/cdc/db1/head", nil)
	req.Header.Set("Authorization", "Bearer token")
	app.routes().ServeHTTP(head, req)
	if head.Code != http.StatusOK || !strings.Contains(head.Body.String(), `"rows":"12"`) {
		t.Fatalf("head status=%d body=%s", head.Code, head.Body.String())
	}
	unreadable := &api{shareRoot: filepath.Join(root, "not-a-dir"), token: "token"}
	rec = getCDC(t, unreadable, "db1", "from=0&limit=1", "token")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unreadable status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestReadWhileFileIsAppended(t *testing.T) {
	app, root := testApp(t)
	writeInstance(t, root, "db1", fixtureLog(0, frameFixture(1, 0, upsertFixture(1))))
	path := filepath.Join(root, "db1", "main.cdc")
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Error(err)
			return
		}
		defer f.Close()
		for i := 2; i <= 50; i++ {
			if _, err := f.Write(frameFixture(uint64(i), 0, upsertFixture(uint64(i)))); err != nil {
				t.Error(err)
				return
			}
		}
	}()
	for i := 0; i < 20; i++ {
		rec := getCDC(t, app, "db1", "from=0&limit=1000", "token")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
		}
	}
	wg.Wait()
}

func testApp(t *testing.T) (*api, string) {
	t.Helper()
	root := t.TempDir()
	app := &api{shareRoot: root, token: "token"}
	return app, root
}

func writeInstance(t *testing.T, root, instance string, cdc []byte) {
	t.Helper()
	dir := filepath.Join(root, instance)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.cdc"), cdc, 0o644); err != nil {
		t.Fatal(err)
	}
	dat := make([]byte, 512)
	copy(dat[:8], []byte{'A', 'S', 'M', 'D', 'B'})
	binary.LittleEndian.PutUint64(dat[24:32], 12)
	if err := os.WriteFile(filepath.Join(dir, "main.dat"), dat, 0o644); err != nil {
		t.Fatal(err)
	}
}

func getCDC(t *testing.T, app *api, instance, query, token string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/cdc/"+instance+"?"+query, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/x-ndjson")
	app.routes().ServeHTTP(rec, req)
	return rec
}

func ndjsonLines(rec *httptest.ResponseRecorder) []string {
	body := strings.TrimSpace(rec.Body.String())
	if body == "" {
		return nil
	}
	return strings.Split(body, "\n")
}
