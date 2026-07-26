package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUpgradeTriggerOnlyIncompatibleFormat(t *testing.T) {
	if !isIncompatibleFormatError(errText("incompatible database format - refusing to open test.dat")) {
		t.Fatal("incompatible format error did not trigger")
	}
	for _, msg := range []string{
		"database is locked by another process (single-writer)",
		"database file is incomplete or corrupt - refusing to open test.dat",
		"engine exited during startup",
	} {
		if isIncompatibleFormatError(errText(msg)) {
			t.Fatalf("unexpected upgrade trigger for %q", msg)
		}
	}
}

func TestSuccessfulUpgradeSwapsFilesAndEngineOpens(t *testing.T) {
	bin := writeFakeEngineLauncher(t)
	dir := t.TempDir()
	db := filepath.Join(dir, "main")
	writeFile(t, db+".dat", "INCOMPATIBLE")

	e, err := NewEngine(bin, dir, "main")
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close(context.Background())

	if got := readFile(t, db+".dat"); got != "UPGRADED" {
		t.Fatalf("dat = %q, want upgraded file", got)
	}
	if got := readFile(t, db+".dat.old"); got != "INCOMPATIBLE" {
		t.Fatalf("dat.old = %q, want original", got)
	}
	if _, err := os.Stat(db + ".upgraded.dat"); !os.IsNotExist(err) {
		t.Fatalf("upgraded file still exists or stat failed: %v", err)
	}
	if _, err := e.Command(context.Background(), "COUNT", waitStatus); err != nil {
		t.Fatalf("engine did not open after upgrade: %v", err)
	}
}

func TestInterruptedUpgradeSwapRecoveryCompletes(t *testing.T) {
	bin := writeFakeEngineLauncher(t)
	dir := t.TempDir()
	db := filepath.Join(dir, "main")
	writeFile(t, db+".dat.old", "INCOMPATIBLE")
	writeFile(t, db+".upgraded.dat", "UPGRADED")

	e, err := NewEngine(bin, dir, "main")
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close(context.Background())

	if got := readFile(t, db+".dat"); got != "UPGRADED" {
		t.Fatalf("dat = %q, want recovered upgraded file", got)
	}
	if got := readFile(t, db+".dat.old"); got != "INCOMPATIBLE" {
		t.Fatalf("dat.old = %q, want original preserved", got)
	}
	if _, err := os.Stat(db + ".upgraded.dat"); !os.IsNotExist(err) {
		t.Fatalf("upgraded file still exists or stat failed: %v", err)
	}
}

func TestFailedUpgradeLeavesOriginalUntouchedAndDoesNotStart(t *testing.T) {
	bin := writeFakeEngineLauncher(t)
	dir := t.TempDir()
	db := filepath.Join(dir, "main")
	writeFile(t, db+".dat", "FAILUPGRADE")

	e, err := NewEngine(bin, dir, "main")
	if err == nil {
		e.Close(context.Background())
		t.Fatal("NewEngine succeeded after failed upgrade")
	}
	if !strings.Contains(err.Error(), "database upgrade failed") {
		t.Fatalf("err = %v, want upgrade failure", err)
	}
	if got := readFile(t, db+".dat"); got != "FAILUPGRADE" {
		t.Fatalf("dat = %q, want original untouched", got)
	}
	if _, err := os.Stat(db + ".dat.old"); !os.IsNotExist(err) {
		t.Fatalf("dat.old exists after failed upgrade: %v", err)
	}
}

func TestNonFormatStartupErrorsDoNotUpgrade(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		ok   bool
	}{
		{name: "lock", body: "LOCK"},
		{name: "corrupt", body: "CORRUPT"},
		{name: "missing", body: "", ok: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bin := writeFakeEngineLauncher(t)
			dir := t.TempDir()
			db := filepath.Join(dir, "main")
			if tc.body != "" {
				writeFile(t, db+".dat", tc.body)
			}
			e, err := NewEngine(bin, dir, "main")
			if tc.ok {
				if err != nil {
					t.Fatal(err)
				}
				e.Close(context.Background())
			} else if err == nil {
				e.Close(context.Background())
				t.Fatal("NewEngine succeeded unexpectedly")
			}
			if _, err := os.Stat(db + ".upgraded.dat"); !os.IsNotExist(err) {
				t.Fatalf("upgrade was attempted; upgraded stat = %v", err)
			}
			if _, err := os.Stat(db + ".dat.old"); !os.IsNotExist(err) {
				t.Fatalf("upgrade swap was attempted; old stat = %v", err)
			}
		})
	}
}

type errText string

func (e errText) Error() string { return string(e) }

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
