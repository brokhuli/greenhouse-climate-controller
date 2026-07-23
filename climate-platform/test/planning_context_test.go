//go:build integration

package test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
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

// planningContextResponse mirrors the platform-optimizer-planning-rest PlanningContext shape
// closely enough to assert the fields this test drives; it is deliberately not the handler's
// DTO (unexported) so the wire JSON is what gets checked.
type planningContextResponse struct {
	GreenhouseID  string `json:"greenhouse_id"`
	SchemaVersion int    `json:"schema_version"`
	From          string `json:"from"`
	To            string `json:"to"`
	Interval      string `json:"interval"`
	Setpoints     struct {
		Source  string           `json:"source"`
		Targets domain.Setpoints `json:"targets"`
		Bounds  *struct {
			TemperatureDayC *domain.Bound `json:"temperature_day_c"`
		} `json:"bounds"`
	} `json:"setpoints"`
	Telemetry []struct {
		Metric  string  `json:"metric"`
		ZoneID  *string `json:"zone_id"`
		Buckets []struct {
			Mean  float64 `json:"mean"`
			Count int64   `json:"count"`
		} `json:"buckets"`
	} `json:"telemetry"`
	Actuators []struct {
		Actuator string `json:"actuator"`
		Health   string `json:"health"`
	} `json:"actuators"`
	DataQuality struct {
		ControllerMode string   `json:"controller_mode"`
		TimeScale      *float64 `json:"time_scale"`
		Freshness      []struct {
			Metric     string   `json:"metric"`
			AgeSeconds *float64 `json:"age_seconds"`
		} `json:"freshness"`
		Faults []struct {
			Metric string `json:"metric"`
			Kind   string `json:"kind"`
		} `json:"faults"`
	} `json:"data_quality"`
}

// TestPlanningContextHTTP drives the Phase 3 optimizer read path end to end against a real DB:
// seeded telemetry becomes bucketed summaries and freshness signals, the live controller
// snapshot supplies mode / actuator health / faults, and the active profile's envelope is
// exposed as bounds.
func TestPlanningContextHTTP(t *testing.T) {
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

	controller := &fakeController{}
	controllerSrv := httptest.NewServer(controller.handler())
	defer controllerSrv.Close()

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
		"controller": map[string]any{"rest_base_url": controllerSrv.URL, "mqtt_topic_root": "gh/gh-a", "bearer_token": nil},
	}, http.StatusCreated)
	fleet.Observe("gh-a", time.Now().UTC())

	// Assign a profile whose stage carries a crop-safe envelope, so the read's setpoints.bounds
	// is populated (the envelope resolver shares the optimizer-write gate's path).
	profile := domain.CropProfile{
		ID: "lettuce", Name: "Lettuce", Crop: "lettuce",
		Stages: []domain.ProfileStage{{
			Stage:   "vegetative",
			Targets: sampleSetpoints(),
			Bounds:  &domain.StageBounds{TemperatureDayC: &domain.Bound{Min: 20, Max: 26}},
		}},
	}
	client.do(http.MethodPost, "/api/profiles", profile, http.StatusCreated)
	client.do(http.MethodPut, "/api/greenhouses/gh-a/assignment", map[string]any{
		"profile_id": "lettuce", "stage": "vegetative",
	}, http.StatusOK)

	// Seed a 6-hour hourly telemetry trail plus latest actuator states. The window anchors to
	// the newest stored timestamp, so `to` == latest and the freshest metric is zero seconds old.
	latest := time.Date(2026, 7, 22, 14, 0, 0, 0, time.UTC)
	var readings []domain.Reading
	benchA := "bench-a"
	for i := 0; i < 6; i++ {
		ts := latest.Add(time.Duration(i-5) * time.Hour)
		readings = append(readings,
			domain.Reading{GreenhouseID: "gh-a", Metric: "temperature", Value: 21 + float64(i), Unit: "°C", TS: ts},
			domain.Reading{GreenhouseID: "gh-a", ZoneID: &benchA, Metric: "soil_moisture", Value: 0.4, Unit: "VWC", TS: ts},
		)
	}
	if err := st.InsertReadings(ctx, readings); err != nil {
		t.Fatalf("insert readings: %v", err)
	}
	observed := 30.0
	if err := st.InsertActuators(ctx, []domain.ActuatorSample{
		{GreenhouseID: "gh-a", Actuator: "fans", Commanded: 40, Observed: &observed, TS: latest},
		{GreenhouseID: "gh-a", ZoneID: &benchA, Actuator: "irrigation_valve", Commanded: 0, TS: latest},
	}); err != nil {
		t.Fatalf("insert actuators: %v", err)
	}

	// Prime the live controller snapshot the read joins onto: mode, actuator health, an active
	// sensor fault, and real-time clock.
	scale := 1.0
	fleet.SetTimeScale("gh-a", &scale)
	fleet.SetControllerMode("gh-a", "degraded")
	fleet.SetActuatorHealth("gh-a", "fans", "", "stuck")
	fleet.SetSensorFaults("gh-a", map[state.FaultKey]string{{Component: "temperature"}: "out_of_range"}, latest)

	var got planningContextResponse
	client.doInto(http.MethodGet, "/api/greenhouses/gh-a/planning-context?window=12h&interval=1h", nil, http.StatusOK, &got)

	if got.GreenhouseID != "gh-a" || got.SchemaVersion != 1 || got.Interval != "1h" {
		t.Fatalf("envelope wrong: %+v", got)
	}
	if got.Setpoints.Source != string(domain.SourceProfile) {
		t.Fatalf("source = %q, want profile", got.Setpoints.Source)
	}
	if got.Setpoints.Bounds == nil || got.Setpoints.Bounds.TemperatureDayC == nil || got.Setpoints.Bounds.TemperatureDayC.Max != 26 {
		t.Fatalf("crop-safe bounds not exposed: %+v", got.Setpoints.Bounds)
	}

	// Telemetry came back as non-empty (min, mean, max) summaries per metric/zone.
	var tempSeries, soilSeries bool
	for _, series := range got.Telemetry {
		if len(series.Buckets) == 0 || series.Buckets[0].Count == 0 {
			t.Fatalf("empty/zero-count bucket for %s: %+v", series.Metric, series.Buckets)
		}
		if series.Metric == "temperature" && series.ZoneID == nil {
			tempSeries = true
		}
		if series.Metric == "soil_moisture" && series.ZoneID != nil && *series.ZoneID == "bench-a" {
			soilSeries = true
		}
	}
	if !tempSeries || !soilSeries {
		t.Fatalf("expected house temperature + zone soil-moisture series: %+v", got.Telemetry)
	}

	// Actuator health is joined from the live snapshot; the zone valve, unseen, is the ok default.
	health := map[string]string{}
	for _, actuator := range got.Actuators {
		health[actuator.Actuator] = actuator.Health
	}
	if health["fans"] != "stuck" {
		t.Fatalf("fans health = %q, want stuck", health["fans"])
	}
	if health["irrigation_valve"] != "ok" {
		t.Fatalf("unseen valve health = %q, want the ok default", health["irrigation_valve"])
	}

	if got.DataQuality.ControllerMode != "degraded" {
		t.Fatalf("controller_mode = %q, want degraded", got.DataQuality.ControllerMode)
	}
	if got.DataQuality.TimeScale == nil || *got.DataQuality.TimeScale != 1.0 {
		t.Fatalf("time_scale = %v, want 1.0", got.DataQuality.TimeScale)
	}
	if len(got.DataQuality.Faults) != 1 || got.DataQuality.Faults[0].Metric != "temperature" || got.DataQuality.Faults[0].Kind != "out_of_range" {
		t.Fatalf("sensor faults wrong: %+v", got.DataQuality.Faults)
	}
	// The latest temperature reading defines `to`, so its freshness age is zero.
	for _, fresh := range got.DataQuality.Freshness {
		if fresh.Metric == "temperature" {
			if fresh.AgeSeconds == nil || *fresh.AgeSeconds != 0 {
				t.Fatalf("temperature age = %v, want 0", fresh.AgeSeconds)
			}
		}
	}

	// Unknown greenhouse is 404; an out-of-enum window is 422.
	client.do(http.MethodGet, "/api/greenhouses/gh-x/planning-context", nil, http.StatusNotFound)
	client.do(http.MethodGet, "/api/greenhouses/gh-a/planning-context?window=1h", nil, http.StatusUnprocessableEntity)
}
