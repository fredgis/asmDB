package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPrepareUpgradeTakesBackupAndReportsSuccess(t *testing.T) {
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	app := &api{engine: e, token: "instance", platformToken: "platform"}

	rec := requestPrepareUpgrade(t, app, "platform", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body prepareUpgradeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.Backup == nil {
		t.Fatalf("response = %#v, want ok backup", body)
	}
	if body.Backup.ApparentBytes != "12" {
		t.Fatalf("apparentBytes = %q, want 12", body.Backup.ApparentBytes)
	}
	if _, err := os.Stat(body.Backup.Path); err != nil {
		t.Fatalf("backup file missing at %q: %v", body.Backup.Path, err)
	}
	if !strings.Contains(body.Backup.Path, ".pre-upgrade.") {
		t.Fatalf("backup path = %q, want recognisable pre-upgrade name", body.Backup.Path)
	}
}

func TestPrepareUpgradeAuth(t *testing.T) {
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	app := &api{engine: e, token: "instance", platformToken: "platform"}

	if rec := requestPrepareUpgrade(t, app, "", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no credential status = %d, want 401", rec.Code)
	}
	if rec := requestPrepareUpgrade(t, app, "platform", ""); rec.Code != http.StatusOK {
		t.Fatalf("platform credential status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestPrepareUpgradeIgnoresCallerSuppliedValues(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "commands.log")
	t.Setenv("ASMDB_FAKE_COMMAND_LOG", logPath)
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	app := &api{engine: e, token: "instance", platformToken: "platform"}

	const sentinel = "CALLER_SUPPLIED_SENTINEL"
	rec := requestPrepareUpgrade(t, app, "platform", `{"command":"BACKUP `+sentinel+`","path":"`+sentinel+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	commands, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(commands)
	if strings.Contains(text, sentinel) {
		t.Fatalf("caller supplied value reached engine command log: %q", text)
	}
	if got := strings.Count(text, "BACKUP "); got != 1 {
		t.Fatalf("BACKUP commands = %d in %q, want 1", got, text)
	}
}

func TestPrepareUpgradeBackupFailureIsDistinguishable(t *testing.T) {
	t.Setenv("ASMDB_FAKE_BACKUP_FAIL", "1")
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	app := &api{engine: e, token: "instance", platformToken: "platform"}

	rec := requestPrepareUpgrade(t, app, "platform", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body prepareUpgradeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.OK || body.Error != "backup_failed" || body.Detail == "" {
		t.Fatalf("response = %#v, want distinguishable backup failure", body)
	}
}

func TestPrepareUpgradeUsesLongCommandBudget(t *testing.T) {
	oldShort, oldLong, oldGrace := shortCommandTimeout, longCommandTimeout, engineUnresponsiveGrace
	shortCommandTimeout = 10 * time.Millisecond
	longCommandTimeout = 500 * time.Millisecond
	engineUnresponsiveGrace = 10 * time.Millisecond
	t.Cleanup(func() {
		shortCommandTimeout = oldShort
		longCommandTimeout = oldLong
		engineUnresponsiveGrace = oldGrace
	})
	t.Setenv("ASMDB_FAKE_BACKUP_SLEEP", "50ms")
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	app := &api{engine: e, token: "instance", platformToken: "platform"}

	rec := requestPrepareUpgrade(t, app, "platform", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body prepareUpgradeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK {
		t.Fatalf("response = %#v, want long-budget backup success", body)
	}
}

func requestPrepareUpgrade(t *testing.T, app *api, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/prepare-upgrade", stringsReader(body))
	if token != "" {
		setBearer(req, token)
	}
	rec := httptest.NewRecorder()
	app.routes().ServeHTTP(rec, req)
	return rec
}
