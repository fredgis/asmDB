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
	AdminKey       string
	SiteDir        string
}

func loadConfig() (config, error) {
	cfg := config{
		Port:           getenv("PORT", "8080"),
		SubscriptionID: os.Getenv("AZURE_SUBSCRIPTION_ID"),
		ResourceGroup:  getenv("ASMDB_RESOURCE_GROUP", "<service-resource-group>"),
		Environment:    getenv("ASMDB_ENVIRONMENT", "asmdb-env"),
		Image:          os.Getenv("ASMDB_IMAGE"),
		Location:       getenv("ASMDB_LOCATION", "swedencentral"),
		StorageAccount: os.Getenv("ASMDB_STORAGE_ACCOUNT"),
		AdminKey:       os.Getenv("ASMDB_ADMIN_KEY"),
		SiteDir:        getenv("ASMDB_SITE_DIR", "/app/site"),
	}

	var missing []string
	if cfg.SubscriptionID == "" {
		missing = append(missing, "AZURE_SUBSCRIPTION_ID")
	}
	if cfg.Image == "" {
		missing = append(missing, "ASMDB_IMAGE")
	}
	if len(missing) > 0 {
		return cfg, fmt.Errorf("missing required environment variable(s): %v", missing)
	}
	return cfg, nil
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

	api := newAPI(store, provisioner, cfg.AdminKey)
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
