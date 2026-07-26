package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
)

type config struct {
	Port           string
	SubscriptionID string
	ResourceGroup  string
	Environment    string
	Image          string
	Location       string
	StorageAccount string
	EnvStorage     string
	PublicBase     string
	PlatformSecret string
	SiteDir        string
	EntraTenantID  string
	EntraClientID  string
	EntraGroupID   string
	EntraScope     string
	BackupTimeout  time.Duration
}

func loadConfig() (config, error) {
	entraClientID := os.Getenv("ASMDB_ENTRA_CLIENT_ID")
	backupTimeout, err := parseBackupTimeout(os.Getenv("ASMDB_BACKUP_TIMEOUT"))
	if err != nil {
		return config{}, err
	}
	cfg := config{
		Port:           getenv("PORT", "8080"),
		SubscriptionID: os.Getenv("AZURE_SUBSCRIPTION_ID"),
		ResourceGroup:  getenv("ASMDB_RESOURCE_GROUP", "<service-resource-group>"),
		Environment:    getenv("ASMDB_ENVIRONMENT", "asmdb-env"),
		Image:          os.Getenv("ASMDB_IMAGE"),
		Location:       getenv("ASMDB_LOCATION", "swedencentral"),
		StorageAccount: os.Getenv("ASMDB_STORAGE_ACCOUNT"),
		EnvStorage:     getenv("ASMDB_ENV_STORAGE", "asmdb-data"),
		PublicBase:     os.Getenv("ASMDB_PUBLIC_BASE"),
		PlatformSecret: os.Getenv("ASMDB_PLATFORM_SECRET"),
		SiteDir:        getenv("ASMDB_SITE_DIR", "/app/site"),
		EntraTenantID:  os.Getenv("ASMDB_ENTRA_TENANT_ID"),
		EntraClientID:  entraClientID,
		EntraGroupID:   os.Getenv("ASMDB_ENTRA_GROUP_ID"),
		EntraScope:     "api://" + entraClientID + "/" + entraScopeName,
		BackupTimeout:  backupTimeout,
	}

	var missing []string
	if cfg.SubscriptionID == "" {
		missing = append(missing, "AZURE_SUBSCRIPTION_ID")
	}
	if cfg.Image == "" {
		missing = append(missing, "ASMDB_IMAGE")
	}
	if cfg.EntraTenantID == "" {
		missing = append(missing, "ASMDB_ENTRA_TENANT_ID")
	}
	if cfg.EntraClientID == "" {
		missing = append(missing, "ASMDB_ENTRA_CLIENT_ID")
	}
	if cfg.EntraGroupID == "" {
		missing = append(missing, "ASMDB_ENTRA_GROUP_ID")
	}
	if len(missing) > 0 {
		return cfg, fmt.Errorf("missing required environment variable(s): %v", missing)
	}
	return cfg, nil
}

func parseBackupTimeout(value string) (time.Duration, error) {
	if value == "" {
		return defaultBackupTimeout, nil
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("ASMDB_BACKUP_TIMEOUT must be a positive Go duration such as 30m: %q", value)
	}
	return parsed, nil
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	if cfg.PlatformSecret == "" {
		log.Printf("ASMDB_PLATFORM_SECRET is empty; live instance stats are disabled")
	}

	cred, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		log.Fatalf("create Azure credential: %v", err)
	}

	store, err := newStore(ctx, cfg, cred)
	if err != nil {
		log.Fatalf("create metadata store: %v", err)
	}

	provisioner, err := newAzureProvisioner(ctx, cfg, cred)
	if err != nil {
		log.Fatalf("create Azure provisioner: %v", err)
	}

	verifier, err := newOIDCAccessTokenVerifier(context.Background(), cfg)
	if err != nil {
		log.Printf("Entra token verifier unavailable; management API will fail closed: %v", err)
	}

	api := newAPI(store, provisioner, cfg, verifier)
	mux := http.NewServeMux()
	api.register(mux)
	registerStatic(mux, cfg.SiteDir)

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("asmdb control plane listening on :%s", cfg.Port)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
