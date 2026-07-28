//go:build integration

package test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/api"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/config"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ingest"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/reconcile"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/relay"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ws"
)

type eventRow struct {
	GreenhouseID string `json:"greenhouse_id"`
	Kind         string `json:"kind"`
	Severity     string `json:"severity"`
	Message      string `json:"message"`
	Source       string `json:"source"`
}

// TestOptimizerOutcomeIngestHTTP drives the optimizer→platform outcome-report ingest end to end
// against a real DB: an escalation report becomes an activity-feed event, mapped to the right kind by
// its reason code, sourced to the optimizer, with the reason + run id + detail in the message.
func TestOptimizerOutcomeIngestHTTP(t *testing.T) {
	ctx := context.Background()
	dsn := newTimescale(t)
	if err := store.Migrate(dsn); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	st, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer st.Close()
	if err := st.EnsureTimescale(ctx, 30); err != nil {
		t.Fatalf("ensure timescale: %v", err)
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	fleet := state.NewFleet(time.Hour)
	hub := ws.NewHub(log)
	ing := ingest.New(st, fleet, hub, nil, log, "tcp://localhost:1883", 4096, time.Hour)
	relayClient := relay.New(5 * time.Second)
	reconciler := reconcile.New(st, relayClient, fleet, hub, nil, log, reconcile.Config{Interval: time.Hour})
	server := api.New(st, fleet, ing, relayClient, reconciler, hub, nil, config.ServiceAuthModeTrustedNetwork, nil, log)
	platform := httptest.NewServer(server.Handler())
	defer platform.Close()

	client := &apiClient{t: t, base: platform.URL}
	client.do(http.MethodPost, "/api/greenhouses", map[string]any{
		"id": "gh-a", "display_name": "House A",
		"controller": map[string]any{"rest_base_url": "http://gh-a", "mqtt_topic_root": "gh/gh-a"},
	}, http.StatusCreated)

	runID := "018f9c2e-6b7a-7c31-9e4d-2a1b5c6d7e8f"

	// Failed outcomes map to optimizer_run_failed; held outcomes map to optimizer_plan_held.
	client.do(http.MethodPost, "/api/greenhouses/gh-a/optimizer-outcomes", map[string]any{
		"optimizer_run_id": runID, "status": "failed", "reason_code": "llm_unavailable",
		"message": "planner backend unreachable",
	}, http.StatusAccepted)
	client.do(http.MethodPost, "/api/greenhouses/gh-a/optimizer-outcomes", map[string]any{
		"optimizer_run_id": runID, "status": "held", "reason_code": "low_confidence",
		"message": "confidence 0.42",
	}, http.StatusAccepted)
	// An applied report is a no-op on this channel (its write already emitted the event).
	client.do(http.MethodPost, "/api/greenhouses/gh-a/optimizer-outcomes", map[string]any{
		"optimizer_run_id": runID, "status": "applied",
	}, http.StatusAccepted)

	var failed []eventRow
	client.doInto(http.MethodGet, "/api/events?kind=optimizer_run_failed", nil, http.StatusOK, &failed)
	if len(failed) != 1 {
		t.Fatalf("want one optimizer_run_failed event, got %d: %+v", len(failed), failed)
	}
	ev := failed[0]
	if ev.Source != "optimizer" || ev.Severity != "warning" {
		t.Fatalf("event provenance/severity wrong: %+v", ev)
	}
	for _, want := range []string{"llm_unavailable", "018f9c2e", "planner backend unreachable"} {
		if !strings.Contains(ev.Message, want) {
			t.Fatalf("message %q missing %q", ev.Message, want)
		}
	}

	var held []eventRow
	client.doInto(http.MethodGet, "/api/events?kind=optimizer_plan_held", nil, http.StatusOK, &held)
	if len(held) != 1 {
		t.Fatalf("want one optimizer_plan_held event, got %d: %+v", len(held), held)
	}
}
