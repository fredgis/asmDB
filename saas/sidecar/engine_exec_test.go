package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
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
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	lines, ok, err := e.Exec(context.Background(), "FAIL")
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

func TestExecRejectsExit(t *testing.T) {
	if _, _, err := (&Engine{}).Exec(context.Background(), " EXIT "); err == nil {
		t.Fatal("Exec accepted EXIT")
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

func TestPromptOnSameLineTerminatesResponse(t *testing.T) {
	withShortTestTimeouts(t)
	e := newFakeEngine(t)
	defer e.Close(context.Background())

	lines, err := e.Command(context.Background(), "PROMPT_SAME_LINE", waitStatus)
	if err != nil {
		t.Fatalf("PROMPT_SAME_LINE error = %v, lines = %#v", err, lines)
	}
	if len(lines) != 1 || lines[0] != "same-line output" {
		t.Fatalf("PROMPT_SAME_LINE lines = %#v", lines)
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

func withShortTestTimeouts(t *testing.T) {
	t.Helper()
	oldShort, oldGrace := shortCommandTimeout, engineUnresponsiveGrace
	shortCommandTimeout = 20 * time.Millisecond
	engineUnresponsiveGrace = 20 * time.Millisecond
	t.Cleanup(func() {
		shortCommandTimeout = oldShort
		engineUnresponsiveGrace = oldGrace
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
		switch strings.ToUpper(line) {
		case "FORMAT TSV":
			format = "TSV"
			fmt.Println("[ OK ] format tsv")
			printPrompt()
		case "FORMAT TABLE":
			format = "TABLE"
			fmt.Println("[ OK ] format table")
			printPrompt()
		case "VERSION":
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
			}
			fmt.Println("[ OK ] version")
			printPrompt()
		case "SELECT *":
			if format == "TSV" {
				fmt.Println("R\t1\t5\t10\t10\ttag\tcontent")
			} else {
				fmt.Println("+----+-------+")
				fmt.Println("| id | value |")
				fmt.Println("+----+-------+")
			}
			fmt.Println("[ OK ] 1 row(s)")
			printPrompt()
		case "COUNT":
			fmt.Println("[ OK ] 1")
			printPrompt()
		case "NO_STATUS":
			fmt.Println("first response without status")
			printPrompt()
		case "PROMPT_SAME_LINE":
			fmt.Print("same-line outputasmdb> ")
		case "SECOND":
			fmt.Println("[ OK ] second response")
			printPrompt()
		case "SLOW":
			d, _ := time.ParseDuration(os.Getenv("ASMDB_FAKE_SLOW"))
			if d <= 0 {
				d = 50 * time.Millisecond
			}
			time.Sleep(d)
			fmt.Println("[ OK ] slow")
			printPrompt()
		case "FAIL":
			fmt.Println("[ERR] forced failure")
			printPrompt()
		case "EXIT", "QUIT":
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
