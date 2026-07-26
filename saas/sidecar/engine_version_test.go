package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestEngineVersionServedFromEngineVersionCommand(t *testing.T) {
	t.Setenv("ASMDB_FAKE_VERSION", "7.6.5")
	t.Setenv("ASMDB_FAKE_STORAGE_FORMAT", "99")
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	restore := withCgroupRoot(t, t.TempDir())
	defer restore()

	app := &api{engine: e, token: "instance", started: time.Now()}

	health := httptest.NewRecorder()
	app.routes().ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/health", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("health status = %d, body = %s", health.Code, health.Body.String())
	}
	var healthBody map[string]any
	if err := json.Unmarshal(health.Body.Bytes(), &healthBody); err != nil {
		t.Fatal(err)
	}
	if healthBody["engine"] != "7.6.5" || healthBody["storageFormat"] != "99" {
		t.Fatalf("health version fields = %#v", healthBody)
	}

	stats := requestStats(t, app, "instance")
	if stats.Code != http.StatusOK {
		t.Fatalf("stats status = %d, body = %s", stats.Code, stats.Body.String())
	}
	var statsBody map[string]any
	if err := json.Unmarshal(stats.Body.Bytes(), &statsBody); err != nil {
		t.Fatal(err)
	}
	if statsBody["engine"] != "7.6.5" || statsBody["storageFormat"] != "99" {
		t.Fatalf("stats version fields = %#v", statsBody)
	}

	mcpReq := httptest.NewRequest(http.MethodPost, "/mcp", stringsReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`))
	setBearer(mcpReq, "instance")
	mcp := httptest.NewRecorder()
	app.routes().ServeHTTP(mcp, mcpReq)
	if mcp.Code != http.StatusOK {
		t.Fatalf("mcp status = %d, body = %s", mcp.Code, mcp.Body.String())
	}
	var mcpBody map[string]any
	if err := json.Unmarshal(mcp.Body.Bytes(), &mcpBody); err != nil {
		t.Fatal(err)
	}
	result := mcpBody["result"].(map[string]any)
	serverInfo := result["serverInfo"].(map[string]any)
	if serverInfo["version"] != "7.6.5-sidecar" || serverInfo["storageFormat"] != "99" {
		t.Fatalf("mcp serverInfo = %#v", serverInfo)
	}
}

func TestBadOrMissingEngineVersionReportsUnknown(t *testing.T) {
	for _, mode := range []string{"bad", "missing"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("ASMDB_FAKE_VERSION_MODE", mode)
			e := newFakeEngine(t)
			defer e.Close(context.Background())

			app := &api{engine: e, token: "instance", started: time.Now()}
			health := httptest.NewRecorder()
			app.routes().ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/health", nil))
			if health.Code != http.StatusOK {
				t.Fatalf("health status = %d, body = %s", health.Code, health.Body.String())
			}
			var healthBody map[string]any
			if err := json.Unmarshal(health.Body.Bytes(), &healthBody); err != nil {
				t.Fatal(err)
			}
			if healthBody["engine"] != "unknown" || healthBody["storageFormat"] != "unknown" {
				t.Fatalf("health version fields = %#v", healthBody)
			}

			mcpReq := httptest.NewRequest(http.MethodPost, "/mcp", stringsReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`))
			setBearer(mcpReq, "instance")
			mcp := httptest.NewRecorder()
			app.routes().ServeHTTP(mcp, mcpReq)
			var mcpBody map[string]any
			if err := json.Unmarshal(mcp.Body.Bytes(), &mcpBody); err != nil {
				t.Fatal(err)
			}
			serverInfo := mcpBody["result"].(map[string]any)["serverInfo"].(map[string]any)
			if serverInfo["version"] != "unknown-sidecar" {
				t.Fatalf("mcp version = %#v, want unknown-sidecar", serverInfo["version"])
			}
		})
	}
}

func TestEngineVersionRereadAfterRestart(t *testing.T) {
	t.Setenv("ASMDB_FAKE_VERSION", "1.0.0")
	t.Setenv("ASMDB_FAKE_STORAGE_FORMAT", "2")
	e := newFakeEngine(t)
	defer e.Close(context.Background())
	if info := e.engineInfo(); info.Version != "1.0.0" || info.StorageFormat != "2" {
		t.Fatalf("initial engineInfo = %#v", info)
	}

	t.Setenv("ASMDB_FAKE_VERSION", "1.0.1")
	t.Setenv("ASMDB_FAKE_STORAGE_FORMAT", "3")
	e.cmdMu.Lock()
	e.restartLocked("test restart")
	e.cmdMu.Unlock()

	if info := e.engineInfo(); info.Version != "1.0.1" || info.StorageFormat != "3" {
		t.Fatalf("restarted engineInfo = %#v", info)
	}
}
