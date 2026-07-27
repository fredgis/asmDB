package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

type config struct {
	ShareRoot string
	Token     string
	Port      string
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		logJSON("error", "config_error", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	app, err := newApp(cfg, assertShareReadOnly)
	if err != nil {
		logJSON("error", "startup_refused", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           app.routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logJSON("info", "server_listening", map[string]any{"port": cfg.Port})
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logJSON("error", "server_failed", map[string]any{"error": err.Error()})
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	logJSON("info", "shutdown_started", nil)
	_ = srv.Close()
	logJSON("info", "shutdown_complete", nil)
}

func loadConfig() (config, error) {
	cfg := config{
		ShareRoot: os.Getenv("ASMDB_SHARE_ROOT"),
		Token:     os.Getenv("ASMDB_GATEWAY_TOKEN"),
		Port:      getenv("PORT", "8080"),
	}
	if cfg.ShareRoot == "" {
		return cfg, errors.New("ASMDB_SHARE_ROOT is required")
	}
	if cfg.Token == "" {
		return cfg, errors.New("ASMDB_GATEWAY_TOKEN is required")
	}
	return cfg, nil
}

func newApp(cfg config, checkReadOnly func(string) error) (*api, error) {
	if err := checkReadOnly(cfg.ShareRoot); err != nil {
		return nil, err
	}
	return &api{shareRoot: cfg.ShareRoot, token: cfg.Token}, nil
}

func getenv(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func logJSON(level, msg string, fields map[string]any) {
	rec := map[string]any{
		"ts":    time.Now().UTC().Format(time.RFC3339Nano),
		"level": level,
		"msg":   msg,
	}
	for k, v := range fields {
		rec[k] = v
	}
	_ = json.NewEncoder(os.Stdout).Encode(rec)
}
