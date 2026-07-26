package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestExecRestoresTSVAfterSuccessfulCommand(t *testing.T) {
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	lines, ok, err := e.Exec(context.Background(), "SELECT *")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("Exec reported failure for SELECT *")
	}
	if len(lines) == 0 || !strings.Contains(lines[0], "+") {
		t.Fatalf("Exec output = %#v, want table output", lines)
	}

	lines, err = e.Command(context.Background(), "SELECT *", waitRowsStatus)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) == 0 || !strings.HasPrefix(lines[0], "R\t") {
		t.Fatalf("post-Exec command output = %#v, want TSV row", lines)
	}
}

func TestExecRestoresTSVAfterFailingCommand(t *testing.T) {
	t.Setenv("ASMDB_FAKE_VERIFY_FAIL", "1")
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	lines, ok, err := e.Exec(context.Background(), "VERIFY")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("Exec reported success for FAIL")
	}
	if len(lines) == 0 || !isERR(lines[len(lines)-1]) {
		t.Fatalf("Exec output = %#v, want engine error line", lines)
	}

	lines, err = e.Command(context.Background(), "SELECT *", waitRowsStatus)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) == 0 || !strings.HasPrefix(lines[0], "R\t") {
		t.Fatalf("post-failing-Exec command output = %#v, want TSV row", lines)
	}
}

func TestExecRejectsEmbeddedNewline(t *testing.T) {
	if _, _, err := (&Engine{}).Exec(context.Background(), "COUNT\nSELECT *"); err == nil {
		t.Fatal("Exec accepted embedded newline")
	}
}

func TestExecRejectsOversizedCommand(t *testing.T) {
	if _, _, err := (&Engine{}).Exec(context.Background(), strings.Repeat("x", maxLineBytes+1)); err == nil {
		t.Fatal("Exec accepted oversized command")
	}
}

func TestExecRejectsExit(t *testing.T) {
	if _, _, err := (&Engine{}).Exec(context.Background(), " EXIT "); err == nil {
		t.Fatal("Exec accepted EXIT")
	}
}

func TestPromptTextInRowContentIsData(t *testing.T) {
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	lines, err := e.Command(context.Background(), "PROMPT_CONTENT", waitRowsStatus)
	if err != nil {
		t.Fatalf("PROMPT_CONTENT error = %v, lines = %#v", err, lines)
	}
	rows, err := parseTSVRows(lines)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %#v, want one row", rows)
	}
	if rows[0].Content != "before asmdb> after" {
		t.Fatalf("content = %q, want prompt text preserved", rows[0].Content)
	}
	if !containsLine(lines, "[ OK ] 1 row(s)") {
		t.Fatalf("lines = %#v, want complete frame status", lines)
	}
}

func TestCanceledCommandRestartsInsteadOfLeakingResponse(t *testing.T) {
	withShortTestTimeouts(t)
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	lines, err := e.Command(ctx, "SLOW_LEAK", waitStatus)
	if err == nil {
		t.Fatalf("SLOW_LEAK unexpectedly succeeded: %#v", lines)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("SLOW_LEAK error = %v, want deadline exceeded", err)
	}

	lines, err = e.Command(context.Background(), "SECOND", waitStatus)
	if err != nil {
		t.Fatalf("SECOND error = %v, lines = %#v", err, lines)
	}
	if len(lines) != 1 || lines[0] != "[ OK ] second response" {
		t.Fatalf("SECOND lines = %#v, want only the second command response", lines)
	}
}

func TestExecRejectsOversizedResponse(t *testing.T) {
	t.Setenv("ASMDB_FAKE_BIG_BENCH", "1")
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	oldMax := maxEngineResponseBytes
	maxEngineResponseBytes = 1024
	t.Cleanup(func() { maxEngineResponseBytes = oldMax })
	lines, ok, err := e.Exec(context.Background(), "BENCH 1")
	if err == nil {
		t.Fatalf("BENCH accepted oversized response: ok=%v lines=%d", ok, len(lines))
	}
	var ce codedError
	if !errors.As(err, &ce) || ce.code != "response_too_large" {
		t.Fatalf("BENCH error = %#v, want response_too_large", err)
	}
}

func TestExecHTTPRejectsOversizedRequestBody(t *testing.T) {
	app := &api{token: "instance"}
	body := `{"command":"` + strings.Repeat("x", maxExecRequestBodyBytes) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/exec", stringsReader(body))
	req.Header.Set("Authorization", "Bearer instance")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	app.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d body = %s, want 413", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "request_too_large") {
		t.Fatalf("body = %s, want request_too_large", rec.Body.String())
	}
}

func TestMissingTerminatorCompletesAndNextCommandIsNotDesynchronized(t *testing.T) {
	withShortTestTimeouts(t)
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	lines, err := e.Command(context.Background(), "NO_STATUS", waitStatus)
	if err != nil {
		t.Fatalf("NO_STATUS error = %v, lines = %#v", err, lines)
	}
	if len(lines) != 1 || lines[0] != "first response without status" {
		t.Fatalf("NO_STATUS lines = %#v", lines)
	}

	lines, err = e.Command(context.Background(), "SECOND", waitStatus)
	if err != nil {
		t.Fatalf("SECOND error = %v, lines = %#v", err, lines)
	}
	if len(lines) != 1 || lines[0] != "[ OK ] second response" {
		t.Fatalf("SECOND lines = %#v, want only the second command response", lines)
	}
}

func TestPromptTerminatesResponseWithoutStatus(t *testing.T) {
	withShortTestTimeouts(t)
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	lines, err := e.Command(context.Background(), "NO_STATUS", waitStatus)
	if err != nil {
		t.Fatalf("NO_STATUS error = %v, lines = %#v", err, lines)
	}
	if len(lines) != 1 || lines[0] != "first response without status" {
		t.Fatalf("NO_STATUS lines = %#v", lines)
	}
}

func TestPromptOnSameLineWithoutStatusRestarts(t *testing.T) {
	withShortTestTimeouts(t)
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	lines, err := e.Command(context.Background(), "PROMPT_SAME_LINE", waitStatus)
	if err == nil {
		t.Fatalf("PROMPT_SAME_LINE unexpectedly succeeded: %#v", lines)
	}
	lines, err = e.Command(context.Background(), "SECOND", waitStatus)
	if err != nil {
		t.Fatalf("SECOND error = %v, lines = %#v", err, lines)
	}
	if len(lines) != 1 || lines[0] != "[ OK ] second response" {
		t.Fatalf("SECOND lines = %#v, want only the second command response", lines)
	}
}

func TestMissingTerminatorIsLogged(t *testing.T) {
	withShortTestTimeouts(t)
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	logged := captureStdout(t, func() {
		lines, err := e.Command(context.Background(), "NO_STATUS", waitStatus)
		if err != nil {
			t.Fatalf("NO_STATUS error = %v, lines = %#v", err, lines)
		}
	})
	if !strings.Contains(logged, `"msg":"engine_response_without_status"`) || !strings.Contains(logged, `"command":"NO_STATUS"`) {
		t.Fatalf("protocol violation log missing from %q", logged)
	}
}

func TestMultipleOutputBlocksAreDrainedBeforeNextCommand(t *testing.T) {
	withShortTestTimeouts(t)
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	lines, err := e.Command(context.Background(), "MULTI_BLOCK", waitStatus)
	if err != nil {
		t.Fatalf("MULTI_BLOCK error = %v, lines = %#v", err, lines)
	}
	if strings.Join(lines, "\n") != "first block\n[ OK ] first block" {
		t.Fatalf("MULTI_BLOCK lines = %#v", lines)
	}

	lines, err = e.Command(context.Background(), "SECOND", waitStatus)
	if err != nil {
		t.Fatalf("SECOND error = %v, lines = %#v", err, lines)
	}
	if len(lines) != 1 || lines[0] != "[ OK ] second response" {
		t.Fatalf("SECOND lines = %#v, want only the second command response", lines)
	}
}

func TestBenchReturnsOwnInsertedRowCountAndDrainsTrailingDetails(t *testing.T) {
	withShortTestTimeouts(t)
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	lines, ok, err := e.Exec(context.Background(), "BENCH 100000")
	if err != nil || !ok {
		t.Fatalf("BENCH err = %v ok = %v lines = %#v", err, ok, lines)
	}
	if len(lines) != 1 || lines[0] != "[ OK ] BENCH inserted 100000 rows" {
		t.Fatalf("BENCH lines = %#v, want own inserted-row status only", lines)
	}

	lines, err = e.Command(context.Background(), "SECOND", waitStatus)
	if err != nil {
		t.Fatalf("SECOND error = %v, lines = %#v", err, lines)
	}
	if len(lines) != 1 || lines[0] != "[ OK ] second response" {
		t.Fatalf("SECOND lines = %#v, want only the second command response", lines)
	}
}

func TestReportedExecSequenceDoesNotDriftAfterMalformedSelect(t *testing.T) {
	withShortTestTimeouts(t)
	t.Setenv("ASMDB_FAKE_SELECT_EXTRA_FRAME", "1")
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	lines, ok, err := e.Exec(context.Background(), "SELECT *")
	if err != nil || !ok {
		t.Fatalf("SELECT * err = %v ok = %v lines = %#v", err, ok, lines)
	}
	if !containsLine(lines, "[ OK ] 1 row(s)") {
		t.Fatalf("SELECT * lines = %#v, want SELECT output", lines)
	}

	lines, ok, err = e.Exec(context.Background(), "SCHEMA")
	if err != nil || !ok {
		t.Fatalf("SCHEMA err = %v ok = %v lines = %#v", err, ok, lines)
	}
	if !containsLine(lines, "[ OK ] schema shown") || containsLine(lines, "[ OK ] 1 row(s)") {
		t.Fatalf("SCHEMA lines = %#v, want schema output only", lines)
	}

	for i := 0; i < 2; i++ {
		lines, ok, err = e.Exec(context.Background(), "FIND CDC")
		if err != nil || !ok {
			t.Fatalf("FIND CDC #%d err = %v ok = %v lines = %#v", i+1, err, ok, lines)
		}
		if !containsLine(lines, "[ OK ] 1 row(s)") || containsLine(lines, "[ OK ] schema shown") {
			t.Fatalf("FIND CDC #%d lines = %#v, want FIND output only", i+1, lines)
		}
	}
}

func TestMalformedResponseResynchronizesInsteadOfDriftingForever(t *testing.T) {
	withShortTestTimeouts(t)
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	if _, err := e.Command(context.Background(), "MULTI_BLOCK", waitStatus); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		lines, err := e.Command(context.Background(), "SECOND", waitStatus)
		if err != nil {
			t.Fatalf("SECOND #%d error = %v, lines = %#v", i+1, err, lines)
		}
		if len(lines) != 1 || lines[0] != "[ OK ] second response" {
			t.Fatalf("SECOND #%d lines = %#v, want only the second command response", i+1, lines)
		}
	}
}

func TestCountDoesNotConsumeStaleSelectPage(t *testing.T) {
	withShortTestTimeouts(t)
	t.Setenv("ASMDB_FAKE_COUNT", "100000")
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	e.stateMu.Lock()
	lines := e.lines
	e.stateMu.Unlock()
	for i := 0; i < 20; i++ {
		lines <- fmt.Sprintf("R\t%d\t%d\t1785079967928\t1785079967928\tbench\tsynthetic benchmark record for throughput measurement\n", i+1, i+1)
	}
	lines <- "[ OK ] 20 row(s)\n"
	lines <- "asmdb> "

	got, err := e.Command(context.Background(), "COUNT", waitStatus)
	if err != nil {
		t.Fatalf("COUNT error = %v, lines = %#v", err, got)
	}
	if len(got) != 1 || got[0] != "[ OK ] 100000" {
		t.Fatalf("COUNT lines = %#v, want only COUNT output", got)
	}
	for _, line := range got {
		if strings.HasPrefix(line, "R\t") || strings.Contains(line, "20 row(s)") {
			t.Fatalf("COUNT consumed stale SELECT output: %#v", got)
		}
	}
}

func containsLine(lines []string, want string) bool {
	for _, line := range lines {
		if line == want {
			return true
		}
	}
	return false
}

func withShortTestTimeouts(t *testing.T) {
	t.Helper()
	oldShort, oldGrace := shortCommandTimeout, engineUnresponsiveGrace
	oldPostFrameDrain := postFrameDrainTimeout
	shortCommandTimeout = 20 * time.Millisecond
	engineUnresponsiveGrace = 20 * time.Millisecond
	postFrameDrainTimeout = time.Millisecond
	t.Cleanup(func() {
		shortCommandTimeout = oldShort
		engineUnresponsiveGrace = oldGrace
		postFrameDrainTimeout = oldPostFrameDrain
	})
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	defer func() { os.Stdout = old }()
	fn()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func newFakeEngine(t *testing.T) *Engine {
	t.Helper()
	bin := writeFakeEngineLauncher(t)
	e, err := NewEngine(bin, t.TempDir(), "testdb")
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func writeFakeEngineLauncher(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if runtime.GOOS == "windows" {
		path := filepath.Join(dir, "fake-engine.cmd")
		body := fmt.Sprintf("@echo off\r\nset GO_WANT_ASMDB_FAKE_ENGINE=1\r\n\"%s\" -test.run=TestFakeEngineHelper -- %%*\r\n", os.Args[0])
		if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
		return path
	}
	path := filepath.Join(dir, "fake-engine")
	body := fmt.Sprintf("#!/bin/sh\nGO_WANT_ASMDB_FAKE_ENGINE=1 %q -test.run=TestFakeEngineHelper -- \"$@\"\n", os.Args[0])
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestFakeEngineHelper(t *testing.T) {
	if os.Getenv("GO_WANT_ASMDB_FAKE_ENGINE") != "1" {
		return
	}
	db := fakeEngineDBArg()
	if len(os.Args) > 0 && os.Args[len(os.Args)-1] == "--upgrade" {
		runFakeUpgrade(db)
		return
	}
	if db != "" {
		switch strings.TrimSpace(readFakeFile(db + ".dat")) {
		case "INCOMPATIBLE", "FAILUPGRADE":
			fmt.Println("[ERR] incompatible database format - refusing to open " + db + ".dat")
			os.Exit(1)
		case "LOCK":
			fmt.Println("[ERR] database is locked by another process (single-writer)")
			os.Exit(1)
		case "CORRUPT":
			fmt.Println("[ERR] database file is incomplete or corrupt - refusing to open " + db + ".dat")
			os.Exit(1)
		}
	}
	printPrompt := func() { fmt.Print("asmdb> ") }
	fmt.Println("asmdb fake: type HELP for commands")
	printPrompt()
	format := "TABLE"
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if p := os.Getenv("ASMDB_FAKE_COMMAND_LOG"); p != "" {
			if f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
				_, _ = f.WriteString(line + "\n")
				_ = f.Close()
			}
		}
		upper := strings.ToUpper(line)
		switch {
		case upper == "FORMAT TSV":
			format = "TSV"
			fmt.Println("[ OK ] format tsv")
			printPrompt()
		case upper == "FORMAT TABLE":
			format = "TABLE"
			fmt.Println("[ OK ] format table")
			printPrompt()
		case upper == "VERSION":
			switch os.Getenv("ASMDB_FAKE_VERSION_MODE") {
			case "bad":
				fmt.Println("not a version")
			case "missing":
				// no version lines
			default:
				v := os.Getenv("ASMDB_FAKE_VERSION")
				if v == "" {
					v = "9.8.7"
				}
				sf := os.Getenv("ASMDB_FAKE_STORAGE_FORMAT")
				if sf == "" {
					sf = "42"
				}
				fmt.Println("  asmdb " + v + "   (fake)")
				fmt.Println("  storage format : " + sf)
				if os.Getenv("ASMDB_FAKE_CAPACITY_MODE") != "missing" {
					capacity := os.Getenv("ASMDB_FAKE_RAW_CAPACITY")
					if capacity == "" {
						capacity = "4194304"
					}
					fmt.Println("  capacity       : " + capacity + " slots")
				}
			}
			fmt.Println("[ OK ] version")
			printPrompt()
		case upper == "SELECT *":
			if format == "TSV" {
				fmt.Println("R\t1\t5\t10\t10\ttag\tcontent")
			} else {
				fmt.Println("+----+-------+")
				fmt.Println("| id | value |")
				fmt.Println("+----+-------+")
			}
			fmt.Println("[ OK ] 1 row(s)")
			printPrompt()
			if os.Getenv("ASMDB_FAKE_SELECT_EXTRA_FRAME") == "1" && format == "TABLE" {
				fmt.Println("+----+-------+")
				fmt.Println("| id | value |")
				fmt.Println("+----+-------+")
				fmt.Println("[ OK ] 1 row(s)")
				printPrompt()
			}
		case upper == "SCHEMA":
			fmt.Println("record layout: id value tag content")
			fmt.Println("[ OK ] schema shown")
			printPrompt()
		case upper == "FIND CDC":
			if format == "TSV" {
				fmt.Println("R\t2\t7\t10\t10\tcdc\tchange-data-capture")
			} else {
				fmt.Println("+----+-------+")
				fmt.Println("| 2  | cdc   |")
				fmt.Println("+----+-------+")
			}
			fmt.Println("[ OK ] 1 row(s)")
			printPrompt()
		case strings.HasPrefix(upper, "BENCH "):
			n := strings.TrimSpace(line[len("BENCH "):])
			if n == "" {
				n = "100000"
			}
			if os.Getenv("ASMDB_FAKE_BIG_BENCH") == "1" {
				for i := 0; i < 200; i++ {
					fmt.Println(strings.Repeat("x", 80))
				}
			}
			fmt.Println("[ OK ] BENCH inserted " + n + " rows")
			fmt.Println("  in-RAM insert            : 123456 rows/sec  (engine only, no I/O)")
			fmt.Println("  checkpoint + fsync total : 42 ms  (full-table durable write)")
			printPrompt()
		case upper == "VERIFY":
			if os.Getenv("ASMDB_FAKE_VERIFY_FAIL") == "1" {
				fmt.Println("[ERR] forced verify failure")
			} else {
				fmt.Println("[ OK ] verify")
			}
			printPrompt()
		case upper == "COUNT":
			count := os.Getenv("ASMDB_FAKE_COUNT")
			if count == "" {
				count = "1"
			}
			fmt.Println("[ OK ] " + count)
			printPrompt()
		case upper == "PROMPT_CONTENT":
			fmt.Println("R\t3\t8\t1785004851551\t1785004851551\ttag\tbefore asmdb> after")
			fmt.Println("[ OK ] 1 row(s)")
			printPrompt()
		case strings.HasPrefix(upper, "BACKUP "):
			d, _ := time.ParseDuration(os.Getenv("ASMDB_FAKE_BACKUP_SLEEP"))
			if d > 0 {
				time.Sleep(d)
			}
			if os.Getenv("ASMDB_FAKE_BACKUP_FAIL") == "1" {
				fmt.Println("[ERR] backup failed - write error, file is incomplete")
				printPrompt()
				continue
			}
			target := strings.TrimSpace(line[len("BACKUP "):])
			if err := os.WriteFile(target, []byte("fake backup\n"), 0o600); err != nil {
				fmt.Println("[ERR] cannot open backup file")
				printPrompt()
				continue
			}
			fmt.Println("[ OK ] backup complete")
			printPrompt()
		case upper == "NO_STATUS":
			fmt.Println("first response without status")
			printPrompt()
		case upper == "MULTI_BLOCK":
			fmt.Println("first block")
			fmt.Println("[ OK ] first block")
			printPrompt()
			fmt.Println("stale block")
			fmt.Println("[ OK ] stale block")
			printPrompt()
		case upper == "PROMPT_SAME_LINE":
			fmt.Print("same-line outputasmdb> ")
		case upper == "SECOND":
			fmt.Println("[ OK ] second response")
			printPrompt()
		case upper == "SLOW":
			d, _ := time.ParseDuration(os.Getenv("ASMDB_FAKE_SLOW"))
			if d <= 0 {
				d = 50 * time.Millisecond
			}
			time.Sleep(d)
			fmt.Println("[ OK ] slow")
			printPrompt()
		case upper == "SLOW_LEAK":
			time.Sleep(30 * time.Millisecond)
			fmt.Println("[ OK ] leaked old response")
			printPrompt()
		case upper == "FAIL":
			fmt.Println("[ERR] forced failure")
			printPrompt()
		case upper == "EXIT", upper == "QUIT":
			os.Exit(0)
		default:
			fmt.Println("[ OK ]")
			printPrompt()
		}
	}
	os.Exit(0)
}

func fakeEngineDBArg() string {
	for i, arg := range os.Args {
		if arg == "--" && i+1 < len(os.Args) {
			return os.Args[i+1]
		}
	}
	return ""
}

func readFakeFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

func runFakeUpgrade(db string) {
	if db == "" {
		os.Exit(2)
	}
	content := strings.TrimSpace(readFakeFile(db + ".dat"))
	if content == "FAILUPGRADE" {
		fmt.Println("[ERR] upgrade failed")
		os.Exit(1)
	}
	if content != "INCOMPATIBLE" {
		fmt.Println("[ERR] source is not upgradeable")
		os.Exit(1)
	}
	if err := os.WriteFile(db+".upgraded.dat", []byte("UPGRADED"), 0o600); err != nil {
		fmt.Println("[ERR] " + err.Error())
		os.Exit(1)
	}
	fmt.Println("[ OK ] upgraded")
	os.Exit(0)
}
