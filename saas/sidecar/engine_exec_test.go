package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
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
	fmt.Println("asmdb fake: type HELP for commands")
	format := "TABLE"
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		switch strings.ToUpper(line) {
		case "FORMAT TSV":
			format = "TSV"
			fmt.Println("[ OK ] format tsv")
		case "FORMAT TABLE":
			format = "TABLE"
			fmt.Println("[ OK ] format table")
		case "SELECT *":
			if format == "TSV" {
				fmt.Println("R\t1\t5\t10\t10\ttag\tcontent")
			} else {
				fmt.Println("+----+-------+")
				fmt.Println("| id | value |")
				fmt.Println("+----+-------+")
			}
			fmt.Println("[ OK ] 1 row(s)")
		case "COUNT":
			fmt.Println("[ OK ] 1")
		case "FAIL":
			fmt.Println("[ERR] forced failure")
		case "EXIT", "QUIT":
			os.Exit(0)
		default:
			fmt.Println("[ OK ]")
		}
	}
	os.Exit(0)
}
