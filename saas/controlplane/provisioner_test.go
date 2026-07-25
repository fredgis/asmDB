package main

import (
	"context"
	"regexp"
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appcontainers/armappcontainers/v3"
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

func TestDerivePlatformToken(t *testing.T) {
	const secret = "master-secret"
	id := "db_abcdefghijklmnopqrstuvwx"
	got := derivePlatformToken(secret, id)
	if got == "" {
		t.Fatal("empty platform token")
	}
	if again := derivePlatformToken(secret, id); again != got {
		t.Fatalf("token not stable: %q then %q", got, again)
	}
	if other := derivePlatformToken(secret, "db_bcdefghijklmnopqrstuvwxy"); other == got {
		t.Fatal("different instance ids derived the same platform token")
	}
	if got == secret {
		t.Fatal("derived token must not equal master secret")
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

func TestInstanceGetsPlatformToken(t *testing.T) {
	p := &azureProvisioner{
		location:       "swedencentral",
		image:          "reg.azurecr.io/asmdb-instance:latest",
		envStorage:     "asmdb-data",
		platformSecret: "master-secret",
	}
	in := instance{ID: "db_abcdefghijklmnopqrstuvwx", Tier: "free", ContainerAppName: "db-abcdefghijklmnopqrstuvwx"}
	app, err := p.buildContainerApp(in, "customer-token")
	if err != nil {
		t.Fatal(err)
	}
	want := derivePlatformToken("master-secret", in.ID)
	var got string
	for _, env := range app.Properties.Template.Containers[0].Env {
		if *env.Name == "ASMDB_PLATFORM_TOKEN" {
			got = *env.Value
		}
	}
	if got != want {
		t.Fatalf("ASMDB_PLATFORM_TOKEN = %q, want derived token %q", got, want)
	}
}

func TestInstanceOmitsPlatformTokenWithoutSecret(t *testing.T) {
	p := &azureProvisioner{
		location:   "swedencentral",
		image:      "reg.azurecr.io/asmdb-instance:latest",
		envStorage: "asmdb-data",
	}
	in := instance{ID: "db_abcdefghijklmnopqrstuvwx", Tier: "free", ContainerAppName: "db-abcdefghijklmnopqrstuvwx"}
	app, err := p.buildContainerApp(in, "customer-token")
	if err != nil {
		t.Fatal(err)
	}
	for _, env := range app.Properties.Template.Containers[0].Env {
		if *env.Name == "ASMDB_PLATFORM_TOKEN" {
			t.Fatal("ASMDB_PLATFORM_TOKEN should be omitted without ASMDB_PLATFORM_SECRET")
		}
	}
}

// A Container App's own filesystem is discarded on restart and on scale to
// zero. If the engine's files are not on a mounted volume the customer's
// database evaporates the first time the app goes idle, so the volume wiring
// is asserted here rather than discovered in production.
func TestInstanceGetsADurableVolume(t *testing.T) {
	p := &azureProvisioner{
		location:   "swedencentral",
		image:      "reg.azurecr.io/asmdb-instance:latest",
		envStorage: "asmdb-data",
	}

	for tier := range tierSpecs {
		t.Run(tier, func(t *testing.T) {
			in := instance{ID: "db_abcdefghijklmnopqrstuvwx", Tier: tier, ContainerAppName: "db-abcdefghijklmnopqrstuvwx"}
			app, err := p.buildContainerApp(in, "token")
			if err != nil {
				t.Fatal(err)
			}
			tmpl := app.Properties.Template

			if len(tmpl.Volumes) != 1 {
				t.Fatalf("volumes = %d, want exactly 1 durable volume", len(tmpl.Volumes))
			}
			vol := tmpl.Volumes[0]
			if got := *vol.StorageType; got != armappcontainers.StorageTypeNfsAzureFile {
				t.Fatalf("storage type = %q, want %q (EmptyDir is ephemeral)", got, armappcontainers.StorageTypeNfsAzureFile)
			}
			if got := *vol.StorageName; got != "asmdb-data" {
				t.Fatalf("storage name = %q, want the environment storage", got)
			}

			mounts := tmpl.Containers[0].VolumeMounts
			if len(mounts) != 1 {
				t.Fatalf("volume mounts = %d, want 1", len(mounts))
			}
			if got := *mounts[0].VolumeName; got != *vol.Name {
				t.Fatalf("mount references volume %q, but the volume is named %q", got, *vol.Name)
			}
			// One share holds every database; the sub-path is what keeps one
			// customer's files out of another's.
			if got := *mounts[0].SubPath; got != in.ID {
				t.Fatalf("sub-path = %q, want the instance id %q", got, in.ID)
			}

			// The engine is told where to write by ASMDB_DATA. If that path and
			// the mount path ever drift apart the writes land on the ephemeral
			// layer and the volume sits there empty.
			var dataDir string
			for _, env := range tmpl.Containers[0].Env {
				if *env.Name == "ASMDB_DATA" {
					dataDir = *env.Value
				}
			}
			if dataDir == "" {
				t.Fatal("ASMDB_DATA is not set")
			}
			if dataDir != *mounts[0].MountPath {
				t.Fatalf("ASMDB_DATA = %q but the volume is mounted at %q", dataDir, *mounts[0].MountPath)
			}
		})
	}
}

// The engine is a single-writer process holding an exclusive lock on its files.
// A second replica is not more capacity, it is a second database that cannot
// start, so no tier may ever ask for one.
func TestNoTierEverAsksForASecondReplica(t *testing.T) {
	for tier, spec := range tierSpecs {
		if spec.MaxReplicas != 1 {
			t.Fatalf("tier %q has maxReplicas %d, want 1", tier, spec.MaxReplicas)
		}
	}
}

func TestProvisionerRefusesToStartWithoutStorage(t *testing.T) {
	if _, err := newAzureProvisioner(context.Background(), config{}, nil); err == nil {
		t.Fatal("expected a provisioner with no configuration to be refused")
	}
}

func TestEndpointUsesPublicBase(t *testing.T) {
	p := &azureProvisioner{
		environmentDNS: "internal.example.test",
		publicBase:     "https://asmdb-apim.azure-api.net/db",
	}
	in := instance{ID: "db_7k2m9x4qp1va8ne03wjr5tzy", ContainerAppName: "db-7k2m9x4qp1va8ne03wjr5tzy"}
	want := "https://asmdb-apim.azure-api.net/db/7k2m9x4qp1va8ne03wjr5tzy"
	if got := p.Endpoint(in); got != want {
		t.Fatalf("Endpoint() = %q, want %q", got, want)
	}
}

func TestEndpointTrimsPublicBaseTrailingSlash(t *testing.T) {
	p := &azureProvisioner{
		environmentDNS: "internal.example.test",
		publicBase:     "https://asmdb-apim.azure-api.net/db/",
	}
	in := instance{ID: "db_7k2m9x4qp1va8ne03wjr5tzy", ContainerAppName: "db-7k2m9x4qp1va8ne03wjr5tzy"}
	want := "https://asmdb-apim.azure-api.net/db/7k2m9x4qp1va8ne03wjr5tzy"
	if got := p.Endpoint(in); got != want {
		t.Fatalf("Endpoint() = %q, want %q", got, want)
	}
}

func TestEndpointFallsBackToInternalAddress(t *testing.T) {
	p := &azureProvisioner{environmentDNS: "niceforest.internal"}
	in := instance{ID: "db_7k2m9x4qp1va8ne03wjr5tzy", ContainerAppName: "db-7k2m9x4qp1va8ne03wjr5tzy"}
	want := "https://db-7k2m9x4qp1va8ne03wjr5tzy.niceforest.internal"
	if got := p.Endpoint(in); got != want {
		t.Fatalf("Endpoint() = %q, want %q", got, want)
	}
	if got := p.InternalEndpoint(in); got != want {
		t.Fatalf("InternalEndpoint() = %q, want %q", got, want)
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
