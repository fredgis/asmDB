package main

import (
	"regexp"
	"testing"
)

func TestGenerateInstanceIDShape(t *testing.T) {
	id, err := generateInstanceID()
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^db_[a-z2-7]{24}$`).MatchString(id) {
		t.Fatalf("unexpected id shape: %q", id)
	}
}

func TestGenerateAccessTokenShape(t *testing.T) {
	token, err := generateAccessToken()
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(token) {
		t.Fatalf("unexpected token shape: %q", token)
	}
	if tokenHash(token) == token {
		t.Fatal("token hash must not equal token")
	}
}

func TestTierSpecs(t *testing.T) {
	tests := map[string]tierSpec{
		"free":     {CPU: 0.25, Memory: "0.5Gi", MinReplicas: 0, MaxReplicas: 1, Quota: 3},
		"standard": {CPU: 0.5, Memory: "1Gi", MinReplicas: 0, MaxReplicas: 1, Quota: 20},
		"premium":  {CPU: 1.0, Memory: "2Gi", MinReplicas: 1, MaxReplicas: 1, Quota: 100},
	}
	for tier, want := range tests {
		got := tierSpecs[tier]
		if got != want {
			t.Fatalf("%s spec = %+v, want %+v", tier, got, want)
		}
	}
}

func TestMapAzureState(t *testing.T) {
	tests := []struct {
		name         string
		provisioning string
		running      string
		wantState    string
		wantError    string
	}{
		{"succeeded-running", "Succeeded", "Running", "running", ""},
		{"succeeded-ready", "Succeeded", "Ready", "running", ""},
		{"in-progress", "InProgress", "Progressing", "provisioning", ""},
		{"provisioning", "Provisioning", "", "provisioning", ""},
		{"failed", "Failed", "", "failed", "Failed"},
		{"deleting", "Deleting", "", "deleting", ""},
		{"scaled-zero", "Succeeded", "Stopped", "stopped", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := mapAzureState(tt.provisioning, tt.running)
			if got.State != tt.wantState || got.Error != tt.wantError {
				t.Fatalf("mapAzureState() = %+v, want state %q error %q", got, tt.wantState, tt.wantError)
			}
		})
	}
}
