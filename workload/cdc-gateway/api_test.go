package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
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

func TestSnapshotServesOnlyLiveRowsAndSeq(t *testing.T) {
	app, root := testApp(t)
	writeInstanceWithDat(t, root, "db1", fixtureLog(0), datFixture(42, 0, 0,
		liveRecord(1, "tag1", "alpha"),
		deletedRecord(2),
		emptyRecord(),
		liveRecord(3, "tag3", "gamma"),
	))
	rec := getSnapshot(t, app, "db1", "after=0&limit=10", "token")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-Asmdb-Snapshot-Seq"); got != "42" {
		t.Fatalf("snapshot seq = %q, want 42", got)
	}
	if got := rec.Header().Get("X-Asmdb-Rows"); got != "2" {
		t.Fatalf("rows = %q, want 2", got)
	}
	if got := rec.Header().Get("X-Asmdb-Live-Rows"); got != "2" {
		t.Fatalf("live rows = %q, want 2", got)
	}
	lines := ndjsonLines(rec)
	if len(lines) != 2 {
		t.Fatalf("lines = %d, want 2: %s", len(lines), rec.Body.String())
	}
	var first opJSON
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	if first.Op != "upsert" || first.ID != "1" || first.Record["id"] != "1" || first.Record["value"] != "42" {
		t.Fatalf("first row = %#v", first)
	}
}

func TestSnapshotPagesBySlotIndex(t *testing.T) {
	app, root := testApp(t)
	writeInstanceWithDat(t, root, "db1", fixtureLog(0), datFixture(7, 0, 0,
		liveRecord(1, "a", "one"),
		emptyRecord(),
		liveRecord(2, "b", "two"),
		deletedRecord(3),
		liveRecord(4, "c", "four"),
	))
	first := getSnapshot(t, app, "db1", "after=0&limit=2", "token")
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d body=%s", first.Code, first.Body.String())
	}
	if first.Header().Get("X-Asmdb-Has-More") != "true" || first.Header().Get("X-Asmdb-Next-After") != "3" {
		t.Fatalf("first headers hasMore=%q next=%q", first.Header().Get("X-Asmdb-Has-More"), first.Header().Get("X-Asmdb-Next-After"))
	}
	second := getSnapshot(t, app, "db1", "after="+first.Header().Get("X-Asmdb-Next-After")+"&limit=2", "token")
	if second.Code != http.StatusOK {
		t.Fatalf("second status = %d body=%s", second.Code, second.Body.String())
	}
	if second.Header().Get("X-Asmdb-Has-More") != "false" || second.Header().Get("X-Asmdb-Next-After") != "5" {
		t.Fatalf("second headers hasMore=%q next=%q", second.Header().Get("X-Asmdb-Has-More"), second.Header().Get("X-Asmdb-Next-After"))
	}
	ids := snapshotIDs(t, append(ndjsonLines(first), ndjsonLines(second)...))
	if strings.Join(ids, ",") != "1,2,4" {
		t.Fatalf("ids = %v, want [1 2 4]", ids)
	}
}

func TestSnapshotUnstableBulkIs503(t *testing.T) {
	app, root := testApp(t)
	writeInstanceWithDat(t, root, "db1", fixtureLog(0), datFixture(42, 3, 0, liveRecord(1, "bench", "x")))
	rec := getSnapshot(t, app, "db1", "after=0&limit=10", "token")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]apiError
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error"].Code != "snapshot_unstable" || !strings.Contains(body["error"].Message, "bench") {
		t.Fatalf("body = %#v", body)
	}
}

func TestSnapshotMovedIs409(t *testing.T) {
	app, root := testApp(t)
	writeInstanceWithDat(t, root, "db1", fixtureLog(0), datFixture(42, 0, 0, liveRecord(1, "a", "one")))
	path := filepath.Join(root, "db1", "main.dat")
	snapshotAfterScanHook = func() {
		f, err := os.OpenFile(path, os.O_WRONLY, 0)
		if err != nil {
			t.Error(err)
			return
		}
		defer f.Close()
		var seq [8]byte
		binary.LittleEndian.PutUint64(seq[:], 43)
		if _, err := f.WriteAt(seq[:], hdrSeq); err != nil {
			t.Error(err)
		}
	}
	defer func() { snapshotAfterScanHook = nil }()
	rec := getSnapshot(t, app, "db1", "after=0&limit=10", "token")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"code":"snapshot_moved"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestSnapshotEmptyTableIsOK(t *testing.T) {
	app, root := testApp(t)
	writeInstanceWithDat(t, root, "db1", fixtureLog(0), datFixture(99, 0, 0))
	rec := getSnapshot(t, app, "db1", "after=0&limit=10", "token")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if lines := ndjsonLines(rec); len(lines) != 0 {
		t.Fatalf("lines = %d, want 0", len(lines))
	}
	if rec.Header().Get("X-Asmdb-Snapshot-Seq") != "99" || rec.Header().Get("X-Asmdb-Rows") != "0" {
		t.Fatalf("headers seq=%q rows=%q", rec.Header().Get("X-Asmdb-Snapshot-Seq"), rec.Header().Get("X-Asmdb-Rows"))
	}
}

func TestSnapshotSparseReservationUsesLiveCountToStopAfterRowsFound(t *testing.T) {
	app, root := testApp(t)
	slots := uint64(snapshotSlotBudget * 3)
	live := map[uint64][]byte{
		0: liveRecord(1, "a", "one"),
		2: liveRecord(2, "b", "two"),
		4: liveRecord(3, "c", "three"),
		6: liveRecord(4, "d", "four"),
		8: liveRecord(5, "e", "five"),
	}
	writeSparseInstance(t, root, "sparse", fixtureLog(0), sparseDatFixture(123, 0, 0, 5), slots, live)
	rec := getSnapshot(t, app, "sparse", "after=0&limit=1000", "token")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-Asmdb-Live-Rows"); got != "5" {
		t.Fatalf("live rows = %q, want 5", got)
	}
	if got := rec.Header().Get("X-Asmdb-Has-More"); got != "false" {
		t.Fatalf("has-more = %q, want false", got)
	}
	if got := rec.Header().Get("X-Asmdb-Next-After"); got != "9" {
		t.Fatalf("next-after = %q, want 9", got)
	}
	if lines := ndjsonLines(rec); len(lines) != 5 {
		t.Fatalf("lines = %d, want 5", len(lines))
	}
}

func TestSnapshotSparseEmptyReservationTerminatesWithoutScanning(t *testing.T) {
	app, root := testApp(t)
	writeSparseInstance(t, root, "empty", fixtureLog(0), sparseDatFixture(456, 0, 0, 0), uint64(snapshotSlotBudget*3), nil)
	rec := getSnapshot(t, app, "empty", "after=0&limit=1000", "token")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if lines := ndjsonLines(rec); len(lines) != 0 {
		t.Fatalf("lines = %d, want 0", len(lines))
	}
	if rec.Header().Get("X-Asmdb-Live-Rows") != "0" || rec.Header().Get("X-Asmdb-Has-More") != "false" || rec.Header().Get("X-Asmdb-Next-After") != "0" {
		t.Fatalf("headers live=%q hasMore=%q next=%q", rec.Header().Get("X-Asmdb-Live-Rows"), rec.Header().Get("X-Asmdb-Has-More"), rec.Header().Get("X-Asmdb-Next-After"))
	}
}

func TestSnapshotSparseZeroRowPageRespectsSlotBudget(t *testing.T) {
	app, root := testApp(t)
	slots := uint64(snapshotSlotBudget * 3)
	live := map[uint64][]byte{
		uint64(snapshotSlotBudget + 5): liveRecord(1, "late", "row"),
	}
	writeSparseInstance(t, root, "late", fixtureLog(0), sparseDatFixture(789, 0, 0, 1), slots, live)
	first := getSnapshot(t, app, "late", "after=0&limit=1000", "token")
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d body=%s", first.Code, first.Body.String())
	}
	if lines := ndjsonLines(first); len(lines) != 0 {
		t.Fatalf("first lines = %d, want 0", len(lines))
	}
	if first.Header().Get("X-Asmdb-Has-More") != "true" || first.Header().Get("X-Asmdb-Next-After") != strconv.Itoa(snapshotSlotBudget) {
		t.Fatalf("first headers hasMore=%q next=%q budget=%d", first.Header().Get("X-Asmdb-Has-More"), first.Header().Get("X-Asmdb-Next-After"), snapshotSlotBudget)
	}
	second := getSnapshot(t, app, "late", "after="+first.Header().Get("X-Asmdb-Next-After")+"&limit=1000", "token")
	if second.Code != http.StatusOK {
		t.Fatalf("second status = %d body=%s", second.Code, second.Body.String())
	}
	if lines := ndjsonLines(second); len(lines) != 1 {
		t.Fatalf("second lines = %d, want 1", len(lines))
	}
	if got := second.Header().Get("X-Asmdb-Next-After"); got != strconv.Itoa(snapshotSlotBudget*2) {
		t.Fatalf("second next-after = %q, want %d", got, snapshotSlotBudget*2)
	}
}

func TestSnapshotContentUsesCLen(t *testing.T) {
	app, root := testApp(t)
	full := strings.Repeat("x", 176)
	writeInstanceWithDat(t, root, "db1", fixtureLog(0), datFixture(5, 0, 0,
		liveRecordWithRawContent(1, "short", []byte{'a', 'b', 0, 'c'}, 4),
		liveRecord(2, "full", full),
	))
	rec := getSnapshot(t, app, "db1", "after=0&limit=10", "token")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	lines := ndjsonLines(rec)
	var first, second opJSON
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(lines[1]), &second); err != nil {
		t.Fatal(err)
	}
	if first.Record["content"] != "ab\u0000c" {
		t.Fatalf("content = %q, want embedded NUL honoured", first.Record["content"])
	}
	if second.Record["content"] != full || len(second.Record["content"]) != 176 {
		t.Fatalf("full content len = %d", len(second.Record["content"]))
	}
}

func TestSnapshotAuthAndUnknownInstanceMatchCDC(t *testing.T) {
	app, root := testApp(t)
	writeInstanceWithDat(t, root, "db1", fixtureLog(0), datFixture(1, 0, 0))
	rec := getSnapshot(t, app, "db1", "after=0&limit=1", "bad")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token status = %d", rec.Code)
	}
	rec = getSnapshot(t, app, "missing", "after=0&limit=1", "token")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing status = %d body=%s", rec.Code, rec.Body.String())
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
	dat := make([]byte, 512)
	copy(dat[:8], []byte{'A', 'S', 'M', 'D', 'B'})
	binary.LittleEndian.PutUint64(dat[24:32], 12)
	writeInstanceWithDat(t, root, instance, cdc, dat)
}

func writeInstanceWithDat(t *testing.T, root, instance string, cdc, dat []byte) {
	t.Helper()
	dir := filepath.Join(root, instance)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.cdc"), cdc, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.dat"), dat, 0o644); err != nil {
		t.Fatal(err)
	}
}

func getSnapshot(t *testing.T, app *api, instance, query, token string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/snapshot/"+instance+"?"+query, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/x-ndjson")
	app.routes().ServeHTTP(rec, req)
	return rec
}

func datFixture(seq, bulk, resetp uint64, slots ...[]byte) []byte {
	dat := make([]byte, datHeaderSize+len(slots)*recSize)
	copy(dat[:8], []byte{'A', 'S', 'M', 'D', 'B'})
	binary.LittleEndian.PutUint64(dat[hdrLiveRows:hdrLiveRows+8], countLiveSlots(slots))
	binary.LittleEndian.PutUint64(dat[hdrSeq:hdrSeq+8], seq)
	binary.LittleEndian.PutUint64(dat[hdrResetP:hdrResetP+8], resetp)
	binary.LittleEndian.PutUint64(dat[hdrBulk:hdrBulk+8], bulk)
	for i, slot := range slots {
		copy(dat[datHeaderSize+i*recSize:datHeaderSize+(i+1)*recSize], slot)
	}
	return dat
}

func countLiveSlots(slots [][]byte) uint64 {
	var live uint64
	for _, slot := range slots {
		if len(slot) > recStatus && slot[recStatus] == stOccupied {
			live++
		}
	}
	return live
}

func sparseDatFixture(seq, bulk, resetp, liveRows uint64) []byte {
	header := make([]byte, datHeaderSize)
	copy(header[:8], []byte{'A', 'S', 'M', 'D', 'B'})
	binary.LittleEndian.PutUint64(header[hdrLiveRows:hdrLiveRows+8], liveRows)
	binary.LittleEndian.PutUint64(header[hdrSeq:hdrSeq+8], seq)
	binary.LittleEndian.PutUint64(header[hdrResetP:hdrResetP+8], resetp)
	binary.LittleEndian.PutUint64(header[hdrBulk:hdrBulk+8], bulk)
	return header
}

func writeSparseInstance(t *testing.T, root, instance string, cdc, header []byte, slots uint64, live map[uint64][]byte) {
	t.Helper()
	dir := filepath.Join(root, instance)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.cdc"), cdc, 0o644); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "main.dat")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteAt(header, 0); err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(int64(datHeaderSize + slots*recSize)); err != nil {
		t.Fatal(err)
	}
	for slot, rec := range live {
		if _, err := f.WriteAt(rec, int64(datHeaderSize+slot*recSize)); err != nil {
			t.Fatal(err)
		}
	}
}

func liveRecord(id uint64, tag, content string) []byte {
	return liveRecordWithRawContent(id, tag, []byte(content), uint32(len(content)))
}

func liveRecordWithRawContent(id uint64, tag string, content []byte, clen uint32) []byte {
	rec := make([]byte, recSize)
	binary.LittleEndian.PutUint64(rec[recID:recID+8], id)
	rec[recStatus] = stOccupied
	binary.LittleEndian.PutUint32(rec[recCLen:recCLen+4], clen)
	binary.LittleEndian.PutUint64(rec[recCreated:recCreated+8], 1785246273283)
	binary.LittleEndian.PutUint64(rec[recUpdated:recUpdated+8], 1785246273283)
	binary.LittleEndian.PutUint64(rec[recValue:recValue+8], 42)
	copy(rec[recTag:recContent], []byte(tag))
	copy(rec[recContent:], content)
	return rec
}

func deletedRecord(id uint64) []byte {
	rec := liveRecord(id, "deleted", "deleted")
	rec[recStatus] = 2
	return rec
}

func emptyRecord() []byte {
	return make([]byte, recSize)
}

func snapshotIDs(t *testing.T, lines []string) []string {
	t.Helper()
	ids := make([]string, 0, len(lines))
	for _, line := range lines {
		var op opJSON
		if err := json.Unmarshal([]byte(line), &op); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, op.ID)
	}
	return ids
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
