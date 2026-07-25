package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

type config struct {
	Bin           string
	Data          string
	Name          string
	Token         string
	PlatformToken string
	Port          string
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		logJSON("error", "config_error", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	engine, err := NewEngine(cfg.Bin, cfg.Data, cfg.Name)
	if err != nil {
		logJSON("error", "engine_start_failed", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	app := &api{engine: engine, token: cfg.Token, platformToken: cfg.PlatformToken, started: time.Now()}
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
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	engine.Close(ctx)
	logJSON("info", "shutdown_complete", nil)
}

func loadConfig() (config, error) {
	cfg := config{
		Bin:           getenv("ASMDB_BIN", "/app/asmdb"),
		Data:          getenv("ASMDB_DATA", "/data"),
		Name:          getenv("ASMDB_NAME", "main"),
		Token:         os.Getenv("ASMDB_TOKEN"),
		PlatformToken: os.Getenv("ASMDB_PLATFORM_TOKEN"),
		Port:          getenv("PORT", "8080"),
	}
	if cfg.Token == "" {
		return cfg, errors.New("ASMDB_TOKEN is required")
	}
	return cfg, nil
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
