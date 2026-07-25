package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Source: docs/COST.md §2, Azure Container Apps Consumption public list rates
// for swedencentral, USD, read from Azure Retail Prices API on 2026-07-25.
const (
	containerAppsVCPUActiveUSDPerSecond = 0.000024
	containerAppsVCPUIDLEUSDPerSecond   = 0.000003
	containerAppsMemoryUSDPerGiBSecond  = 0.000003
	costBasis                           = "estimated from Azure Monitor Replicas average time at public list rates; not an invoice"
)

type costResponse struct {
	Basis     string              `json:"basis"`
	From      string              `json:"from"`
	To        string              `json:"to"`
	TotalUSD  float64             `json:"totalUsd"`
	Counts    map[string]int      `json:"counts"`
	Databases []databaseCostEntry `json:"databases"`
}

type databaseCostEntry struct {
	ID                     string  `json:"id"`
	Name                   string  `json:"name"`
	Tier                   string  `json:"tier"`
	Size                   string  `json:"size"`
	State                  string  `json:"state"`
	ActiveHours            float64 `json:"activeHours"`
	PausedHours            float64 `json:"pausedHours"`
	EstimatedComputeUSD    float64 `json:"estimatedComputeUsd"`
	WindowPredatesInstance bool    `json:"windowPredatesInstance"`
	MetricsUnavailable     bool    `json:"metricsUnavailable,omitempty"`
}

func (a *api) handleCosts(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusNotFound, "not_found", "route not found", "")
		return
	}
	if !a.authorized(w, r) {
		return
	}

	from, toTime, err := costWindow(r, a.now())
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid cost window", err.Error())
		return
	}
	instances, err := a.store.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "list metadata", err.Error())
		return
	}
	res := costResponse{
		Basis:  costBasis,
		From:   from.Format(time.RFC3339),
		To:     toTime.Format(time.RFC3339),
		Counts: map[string]int{},
	}
	for _, in := range instances {
		entry := a.costForDatabase(r.Context(), in, from, toTime)
		res.Databases = append(res.Databases, entry)
		res.TotalUSD += entry.EstimatedComputeUSD
		res.Counts[in.Tier]++
	}
	res.TotalUSD = roundCurrency(res.TotalUSD)
	writeJSON(w, http.StatusOK, res)
}

func costWindow(r *http.Request, now time.Time) (time.Time, time.Time, error) {
	now = now.UTC()
	from := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	toTime := now
	var err error
	if value := r.URL.Query().Get("from"); value != "" {
		from, err = time.Parse(time.RFC3339, value)
		if err != nil {
			return time.Time{}, time.Time{}, err
		}
		from = from.UTC()
	}
	if value := r.URL.Query().Get("to"); value != "" {
		toTime, err = time.Parse(time.RFC3339, value)
		if err != nil {
			return time.Time{}, time.Time{}, err
		}
		toTime = toTime.UTC()
	}
	if !toTime.After(from) {
		return time.Time{}, time.Time{}, errors.New("to must be after from")
	}
	if toTime.Sub(from) > costMaxWindow {
		from = toTime.Add(-costMaxWindow)
	}
	return from, toTime, nil
}

func (a *api) costForDatabase(ctx context.Context, in instance, from, toTime time.Time) databaseCostEntry {
	spec := tierSpecs[in.Tier]
	state, err := a.provisioner.GetState(ctx, in)
	if err != nil {
		state = liveState{State: "unknown"}
	}
	effectiveFrom := from
	predates := in.CreatedAt.After(from)
	if predates {
		effectiveFrom = in.CreatedAt
	}
	if !toTime.After(effectiveFrom) {
		return databaseCostEntry{
			ID: in.ID, Name: in.Name, Tier: in.Tier, Size: tierSize(spec), State: state.State,
			WindowPredatesInstance: predates,
		}
	}
	samples, err := a.provisioner.ReplicaAverages(ctx, in, effectiveFrom, toTime, costMetricGrain)
	metricsUnavailable := err != nil
	activeSeconds := replicaActiveSeconds(samples, costMetricGrain)
	windowSeconds := toTime.Sub(effectiveFrom).Seconds()
	if activeSeconds > windowSeconds {
		activeSeconds = windowSeconds
	}
	cost := activeSeconds * ((spec.CPU * containerAppsVCPUActiveUSDPerSecond) + (memoryGiB(spec.Memory) * containerAppsMemoryUSDPerGiBSecond))
	return databaseCostEntry{
		ID:                     in.ID,
		Name:                   in.Name,
		Tier:                   in.Tier,
		Size:                   tierSize(spec),
		State:                  state.State,
		ActiveHours:            roundHours(activeSeconds / 3600),
		PausedHours:            roundHours((windowSeconds - activeSeconds) / 3600),
		EstimatedComputeUSD:    roundCurrency(cost),
		WindowPredatesInstance: predates,
		MetricsUnavailable:     metricsUnavailable,
	}
}

func replicaActiveSeconds(samples []replicaSample, grain time.Duration) float64 {
	var seconds float64
	for _, sample := range samples {
		avg := sample.Average
		if avg < 0 {
			avg = 0
		}
		if avg > 1 {
			avg = 1
		}
		seconds += avg * grain.Seconds()
	}
	return seconds
}

func tierSize(spec tierSpec) string {
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", spec.CPU), "0"), ".") + " vCPU / " + spec.Memory
}

func memoryGiB(memory string) float64 {
	value := strings.TrimSuffix(memory, "Gi")
	f, _ := strconv.ParseFloat(value, 64)
	return f
}

func roundHours(v float64) float64 {
	return math.Round(v*1000) / 1000
}

func roundCurrency(v float64) float64 {
	return math.Round(v*10000) / 10000
}
