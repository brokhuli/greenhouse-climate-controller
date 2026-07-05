//go:build integration

package test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/api"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/config"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ingest"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/reconcile"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/relay"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ws"
)

// fakeController stands in for a Phase 1 controller's REST config API: it records the downward
// PATCH paths the platform delivers and serves current setpoints/zones on GET.
type fakeController struct {
	mu       sync.Mutex
	patched  []string
	lastAuth string
}

func (f *fakeController) handler() http.Handler {
	setpoints := []byte(`{"temperature_day_c":20,"temperature_night_c":16,"day_start":"06:00","day_end":"20:00","humidity_low_pct":50,"humidity_high_pct":80,"humidity_deadband_pct":5,"co2_target_ppm":800,"co2_vent_interlock_threshold_pct":20,"vpd_target_kpa":1,"dli_target_mol":15}`)
	zones := []byte(`[{"zone_id":"bench-a","moisture_low_threshold":0.3,"moisture_high_threshold":0.6,"drain_period_secs":600,"schedule":"06:00","soil_moisture_vwc":0.4,"irrigating":false,"faulted":false,"last_cycle_ts":null}]`)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/setpoints"):
			_, _ = w.Write(setpoints)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/zones"):
			_, _ = w.Write(zones)
		case r.Method == http.MethodPatch:
			f.mu.Lock()
			f.patched = append(f.patched, r.URL.Path)
			f.lastAuth = r.Header.Get("Authorization")
			f.mu.Unlock()
			_, _ = w.Write([]byte("{}"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

func (f *fakeController) patchedPaths() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.patched...)
}

func (f *fakeController) lastAuthHeader() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastAuth
}

// TestProfileAssignmentHTTP drives the 2b REST surface end to end against a real DB and a fake
// controller: register → create profile → assign (delivers to the controller, records provenance)
// → sticky operator edit.
func TestProfileAssignmentHTTP(t *testing.T) {
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
	if err := st.EnsureProvenancePrune(ctx, 30); err != nil {
		t.Fatalf("ensure prune: %v", err)
	}

	controller := &fakeController{}
	controllerSrv := httptest.NewServer(controller.handler())
	defer controllerSrv.Close()

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	fleet := state.NewFleet(time.Hour)
	hub := ws.NewHub(log)
	ing := ingest.New(st, fleet, hub, log, "tcp://localhost:1883", 4096, time.Hour)
	relayClient := relay.New(5 * time.Second)
	reconciler := reconcile.New(st, relayClient, fleet, hub, log, reconcile.Config{Interval: time.Hour})
	server := api.New(st, fleet, ing, relayClient, reconciler, hub, nil, config.ServiceAuthModeTrustedNetwork, log)
	platform := httptest.NewServer(server.Handler())
	defer platform.Close()

	client := &apiClient{t: t, base: platform.URL}

	// Register a greenhouse whose controller is the fake server, then mark it online so the
	// reconciler delivers rather than defers.
	client.do(http.MethodPost, "/api/greenhouses", map[string]any{
		"id": "gh-a", "display_name": "House A",
		"controller": map[string]any{"rest_base_url": controllerSrv.URL, "mqtt_topic_root": "gh/gh-a", "bearer_token": "controller-secret"},
	}, http.StatusCreated)
	fleet.Observe("gh-a", time.Now().UTC())

	// Create a crop profile.
	profile := domain.CropProfile{
		ID: "lettuce", Name: "Lettuce", Crop: "lettuce",
		Stages: []domain.ProfileStage{{Stage: "vegetative", Targets: sampleSetpoints()}},
	}
	client.do(http.MethodPost, "/api/profiles", profile, http.StatusCreated)

	var listed []domain.CropProfile
	client.doInto(http.MethodGet, "/api/profiles", nil, http.StatusOK, &listed)
	if len(listed) != 1 || listed[0].ID != "lettuce" {
		t.Fatalf("profile library = %+v", listed)
	}

	// Assign the profile: the platform resolves the stage targets and delivers them.
	client.do(http.MethodPut, "/api/greenhouses/gh-a/assignment", map[string]any{
		"profile_id": "lettuce", "stage": "vegetative",
	}, http.StatusOK)

	var assignment domain.Assignment
	client.doInto(http.MethodGet, "/api/greenhouses/gh-a/assignment", nil, http.StatusOK, &assignment)
	if assignment.ProfileID != "lettuce" || assignment.Stage != "vegetative" {
		t.Fatalf("assignment = %+v", assignment)
	}

	// The assignment must have reached the controller: global setpoints + the one zone.
	paths := controller.patchedPaths()
	if !contains(paths, "/greenhouses/gh-a/setpoints") || !contains(paths, "/greenhouses/gh-a/zones/bench-a") {
		t.Fatalf("controller did not receive resolved setpoints, patched: %v", paths)
	}

	// The per-controller pre-shared token registered above is presented on the downward REST write
	// (RFC-011): dto → registry → relay round-trip.
	if got := controller.lastAuthHeader(); got != "Bearer controller-secret" {
		t.Fatalf("downward call Authorization = %q, want %q", got, "Bearer controller-secret")
	}

	// A sticky operator edit layers onto intended state and is delivered too.
	client.do(http.MethodPatch, "/api/greenhouses/gh-a/setpoints", map[string]any{"temperature_day_c": 25.0}, http.StatusOK)

	current, found, err := st.CurrentRevision(ctx, "gh-a")
	if err != nil || !found {
		t.Fatalf("current revision found=%v err=%v", found, err)
	}
	if current.Revision != 2 || current.Source != domain.SourceOperatorEdit || current.Setpoints.TemperatureDayC != 25 {
		t.Fatalf("current revision = %+v, want rev2 operator_edit temp 25", current)
	}

	// The optimizer's POST /setpoints submission is accepted (202) and records optimizer
	// provenance (RFC-011). In the default trusted_network mode it needs no service token.
	client.do(http.MethodPost, "/api/greenhouses/gh-a/setpoints", map[string]any{"temperature_day_c": 23.0}, http.StatusAccepted)

	current, found, err = st.CurrentRevision(ctx, "gh-a")
	if err != nil || !found {
		t.Fatalf("current revision after optimizer submit found=%v err=%v", found, err)
	}
	if current.Revision != 3 || current.Source != domain.SourceOptimizer || current.Setpoints.TemperatureDayC != 23 {
		t.Fatalf("current revision = %+v, want rev3 optimizer temp 23", current)
	}
}

// apiClient is a tiny JSON HTTP helper for driving the platform under test.
type apiClient struct {
	t    *testing.T
	base string
}

func (a *apiClient) do(method, path string, body any, wantStatus int) {
	a.t.Helper()
	a.doInto(method, path, body, wantStatus, nil)
}

func (a *apiClient) doInto(method, path string, body any, wantStatus int, out any) {
	a.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			a.t.Fatalf("marshal %s %s: %v", method, path, err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, a.base+path, reader)
	if err != nil {
		a.t.Fatalf("new request %s %s: %v", method, path, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	payload, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != wantStatus {
		a.t.Fatalf("%s %s = %d (want %d): %s", method, path, resp.StatusCode, wantStatus, payload)
	}
	if out != nil {
		if err := json.Unmarshal(payload, out); err != nil {
			a.t.Fatalf("decode %s %s: %v (%s)", method, path, err, payload)
		}
	}
}

func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}
