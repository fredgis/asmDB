package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// The rotation token used to be carried on the persisted operation struct, which
// was embedded directly in every database response — so `GET /databases` handed
// a live credential to anyone who could list. The fix separates the wire type
// from the stored type, which makes the leak structurally impossible rather than
// merely avoided.
//
// This test exists to keep it that way: it fails the moment anyone adds a token
// field back to the response type, or serialises the stored operation directly.
func TestOperationResponseCannotCarryTokenMaterial(t *testing.T) {
	stored := &operation{
		Type:                  "rotate-token",
		State:                 "pending_ack",
		StartedAt:             time.Now().UTC(),
		UpdatedAt:             time.Now().UTC(),
		PendingToken:          "PLAINTEXT-SHOULD-NEVER-APPEAR",
		PendingTokenEncrypted: "ENCRYPTED-SHOULD-NEVER-APPEAR",
		PendingTokenExpiresAt: time.Now().UTC().Add(time.Minute),
	}

	body, err := json.Marshal(operationForResponse(stored))
	if err != nil {
		t.Fatal(err)
	}

	for _, forbidden := range []string{
		"PLAINTEXT-SHOULD-NEVER-APPEAR",
		"ENCRYPTED-SHOULD-NEVER-APPEAR",
		"pendingToken",
		"pendingTokenEncrypted",
	} {
		if strings.Contains(string(body), forbidden) {
			t.Fatalf("operation response contains %q: %s", forbidden, body)
		}
	}
}

// The same guarantee, one level up: a whole database response must not leak the
// token either, however the operation reached it.
func TestDatabaseResponseCannotCarryTokenMaterial(t *testing.T) {
	api := newAPI(newMemoryStore(), &fakeProvisioner{states: map[string]liveState{}}, testStatsConfig(), allowVerifier())
	got := api.responseFor(t.Context(), instance{
		ID:               "db_abcdefghijklmnopqrstuvwx",
		Name:             "db",
		Tier:             "free",
		Image:            "reg.azurecr.io/asmdb-instance:1.6.2",
		CreatedAt:        time.Now().UTC(),
		ContainerAppName: "db-test",
		Operation: &operation{
			Type:                  "rotate-token",
			State:                 "pending_ack",
			PendingToken:          "PLAINTEXT-SHOULD-NEVER-APPEAR",
			PendingTokenEncrypted: "ENCRYPTED-SHOULD-NEVER-APPEAR",
		},
	})

	body, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"PLAINTEXT-SHOULD-NEVER-APPEAR", "ENCRYPTED-SHOULD-NEVER-APPEAR", "pendingToken"} {
		if strings.Contains(string(body), forbidden) {
			t.Fatalf("database response contains %q: %s", forbidden, body)
		}
	}
}
