package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestCommandOverBudgetDoesNotImmediatelyRestartEngine(t *testing.T) {
	restore := withEngineTimings(t, 10*time.Millisecond, time.Second, 10*time.Millisecond, 10*time.Millisecond, 1)
	defer restore()
	t.Setenv("ASMDB_FAKE_SLOW", "60ms")
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	gen := e.generation()

	if _, err := e.Command(context.Background(), "SLOW", waitStatus); err != nil {
		t.Fatal(err)
	}
	if got := e.generation(); got != gen {
		t.Fatalf("generation = %d, want unchanged %d", got, gen)
	}
}

func TestRestartBackoffGivesUpAfterBoundedFailures(t *testing.T) {
	var sleeps []time.Duration
	restore := withEngineTimings(t, 10*time.Millisecond, 10*time.Millisecond, 25*time.Millisecond, time.Second, 3)
	defer restore()
	oldSleep := restartSleep
	restartSleep = func(d time.Duration) { sleeps = append(sleeps, d) }
	defer func() { restartSleep = oldSleep }()

	bin := writeFakeEngineLauncher(t)
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "main.dat"), "LOCK")
	e := &Engine{bin: bin, data: dir, name: "main"}

	e.cmdMu.Lock()
	err := e.startWithBackoffLocked("test")
	e.cmdMu.Unlock()
	if err == nil {
		t.Fatal("startWithBackoffLocked succeeded unexpectedly")
	}
	if len(sleeps) != 2 {
		t.Fatalf("sleeps = %#v, want two backoff sleeps", sleeps)
	}
	if sleeps[0] != 25*time.Millisecond || sleeps[1] != 50*time.Millisecond {
		t.Fatalf("sleeps = %#v, want exponential backoff", sleeps)
	}
	if e.healthError() == "" {
		t.Fatal("health error was not recorded")
	}
}

func TestRestartWaitsForOldProcessBeforeStartingReplacement(t *testing.T) {
	restore := withEngineTimings(t, 10*time.Millisecond, 10*time.Millisecond, 10*time.Millisecond, 10*time.Millisecond, 1)
	defer restore()
	bin := writeFakeEngineLauncher(t)
	dir := t.TempDir()
	db := filepath.Join(dir, "main.dat")
	writeFile(t, db, "LOCK")

	cmd := exec.Command(os.Args[0], "-test.run=TestSleeperHelper")
	cmd.Env = append(os.Environ(), "GO_WANT_ASMDB_SLEEPER=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		writeFile(t, db, "")
		close(done)
	}()

	e := &Engine{bin: bin, data: dir, name: "main", cmd: cmd, done: done}
	e.restartLocked("test restart")
	if e.healthError() != "" {
		t.Fatalf("restart did not wait for old process before replacement: %s", e.healthError())
	}
	e.Close(context.Background())
}

func TestLongCommandBudgets(t *testing.T) {
	if commandTimeout("BENCH 10000") != longCommandTimeout {
		t.Fatal("BENCH did not get long timeout")
	}
	if commandTimeout("BACKUP /tmp/x") != longCommandTimeout {
		t.Fatal("BACKUP did not get long timeout")
	}
	if commandTimeout("SELECT *") != shortCommandTimeout {
		t.Fatal("SELECT did not keep short timeout")
	}
}

func TestHealthReportsFailedStartStreak(t *testing.T) {
	restore := withEngineTimings(t, 10*time.Millisecond, 10*time.Millisecond, 10*time.Millisecond, 10*time.Millisecond, 2)
	defer restore()
	oldSleep := restartSleep
	restartSleep = func(time.Duration) {}
	defer func() { restartSleep = oldSleep }()

	bin := writeFakeEngineLauncher(t)
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "main.dat"), "LOCK")
	e := &Engine{bin: bin, data: dir, name: "main"}
	app := &api{engine: e, token: "instance"}
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	app.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("health status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	if e.healthError() == "" {
		t.Fatal("health error was not recorded")
	}
}

func TestSleeperHelper(t *testing.T) {
	if os.Getenv("GO_WANT_ASMDB_SLEEPER") != "1" {
		return
	}
	time.Sleep(10 * time.Second)
}

func withEngineTimings(t *testing.T, short, grace, initialBackoff, maxBackoff time.Duration, maxAttempts int) func() {
	t.Helper()
	oldShort := shortCommandTimeout
	oldLong := longCommandTimeout
	oldGrace := engineUnresponsiveGrace
	oldInitial := restartInitialBackoff
	oldMax := restartMaxBackoff
	oldAttempts := restartMaxAttempts
	shortCommandTimeout = short
	longCommandTimeout = time.Hour
	engineUnresponsiveGrace = grace
	restartInitialBackoff = initialBackoff
	restartMaxBackoff = maxBackoff
	restartMaxAttempts = maxAttempts
	return func() {
		shortCommandTimeout = oldShort
		longCommandTimeout = oldLong
		engineUnresponsiveGrace = oldGrace
		restartInitialBackoff = oldInitial
		restartMaxBackoff = oldMax
		restartMaxAttempts = oldAttempts
	}
}
