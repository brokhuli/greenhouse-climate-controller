package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
)

func planningContextEcho(query string) echo.Context {
	req := httptest.NewRequest(http.MethodGet, "/api/greenhouses/gh-a/planning-context"+query, nil)
	return echo.New().NewContext(req, httptest.NewRecorder())
}

func TestParsePlanningParamsDefaults(t *testing.T) {
	window, interval, verr := parsePlanningParams(planningContextEcho(""))
	if verr != nil {
		t.Fatalf("defaults rejected: %+v", verr)
	}
	// The defaults match the optimizer's 12-hour horizon at the hourly granularity its LLM
	// context strategy consumes.
	if window != "12h" || interval != "1h" {
		t.Fatalf("window=%q interval=%q, want 12h/1h", window, interval)
	}
}

func TestParsePlanningParamsRejectsUnknown(t *testing.T) {
	if _, _, verr := parsePlanningParams(planningContextEcho("?window=1h")); verr == nil {
		t.Fatal("1h is a dashboard window, not a planning window — should be rejected")
	} else if verr.Field != "window" {
		t.Fatalf("field = %q, want window", verr.Field)
	}
	if _, _, verr := parsePlanningParams(planningContextEcho("?interval=5m")); verr == nil {
		t.Fatal("5m is a dashboard interval, not a planning interval — should be rejected")
	} else if verr.Field != "interval" {
		t.Fatalf("field = %q, want interval", verr.Field)
	}
}

func TestParsePlanningParamsAcceptsEnums(t *testing.T) {
	for _, window := range []string{"6h", "12h", "24h", "48h"} {
		if _, _, verr := parsePlanningParams(planningContextEcho("?window=" + window)); verr != nil {
			t.Fatalf("window %s rejected: %+v", window, verr)
		}
	}
	for _, interval := range []string{"1h", "6h", "1d"} {
		if _, _, verr := parsePlanningParams(planningContextEcho("?interval=" + interval)); verr != nil {
			t.Fatalf("interval %s rejected: %+v", interval, verr)
		}
	}
}

func TestGroupSummariesSplitsByMetricAndZone(t *testing.T) {
	t0 := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	benchA, benchB := "bench-a", "bench-b"
	rows := []store.AnalyticsRow{
		{Metric: "temperature", BucketStart: t0, Min: 18, Max: 24, Avg: 21, Count: 60},
		{Metric: "temperature", BucketStart: t0.Add(time.Hour), Min: 19, Max: 25, Avg: 22, Count: 60},
		{Metric: "soil_moisture", ZoneID: &benchA, BucketStart: t0, Min: 0.3, Max: 0.5, Avg: 0.4, Count: 12},
		{Metric: "soil_moisture", ZoneID: &benchB, BucketStart: t0, Min: 0.2, Max: 0.4, Avg: 0.3, Count: 12},
	}

	series := groupSummaries(rows)

	if len(series) != 3 {
		t.Fatalf("expected 3 series (temperature + 2 zones), got %d", len(series))
	}
	if len(series[0].Buckets) != 2 || series[0].ZoneID != nil {
		t.Fatalf("house series wrong: %+v", series[0])
	}
	// The store reports avg; the contract calls it mean.
	if series[0].Buckets[0].Mean != 21 {
		t.Fatalf("mean = %v, want the store's avg 21", series[0].Buckets[0].Mean)
	}
	if series[1].ZoneID == nil || *series[1].ZoneID != "bench-a" || series[2].ZoneID == nil || *series[2].ZoneID != "bench-b" {
		t.Fatalf("zone series not kept distinct: %+v %+v", series[1], series[2])
	}
}

func TestGroupSummariesEmptyIsNonNilSlice(t *testing.T) {
	if series := groupSummaries(nil); series == nil || len(series) != 0 {
		t.Fatalf("empty telemetry must serialize as [], got %v", series)
	}
}

func TestMapActuatorSnapshotsJoinsHealth(t *testing.T) {
	t0 := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	benchA := "bench-a"
	observed := 58.0
	samples := []domain.ActuatorSample{
		{Actuator: "fans", Commanded: 60, Observed: &observed, TS: t0},
		{Actuator: "irrigation_valve", ZoneID: &benchA, Commanded: 100, TS: t0},
		{Actuator: "heater", Commanded: 0, TS: t0},
	}
	snapshot := state.ControllerSnapshot{ActuatorHealth: map[state.ActuatorKey]string{
		{Actuator: "fans"}: "stuck",
		{Actuator: "irrigation_valve", ZoneID: "bench-a"}: "no_response",
	}}

	got := mapActuatorSnapshots(samples, snapshot)

	if got[0].Health != "stuck" {
		t.Fatalf("fans health = %q, want stuck", got[0].Health)
	}
	if got[1].Health != "no_response" {
		t.Fatalf("zone valve health = %q, want no_response", got[1].Health)
	}
	// An actuator the live snapshot has not reported on is healthy, not unknown.
	if got[2].Health != "ok" {
		t.Fatalf("unseen actuator health = %q, want the ok default", got[2].Health)
	}
	if got[1].Observed != nil {
		t.Fatalf("missing readback must stay null, got %v", *got[1].Observed)
	}
}

func TestMapFreshnessAgesAgainstWindowEnd(t *testing.T) {
	to := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	rows := []store.FreshnessRow{
		{Metric: "temperature", LatestTS: to.Add(-90 * time.Second), SampleCount: 120},
		// A sample stamped at the window edge is zero seconds old, never negative.
		{Metric: "humidity", LatestTS: to, SampleCount: 118},
	}

	got := mapFreshness(rows, to)

	if got[0].AgeSeconds == nil || *got[0].AgeSeconds != 90 {
		t.Fatalf("temperature age = %v, want 90", got[0].AgeSeconds)
	}
	if got[0].LatestTS == nil || *got[0].LatestTS != fmtTS(rows[0].LatestTS) {
		t.Fatalf("latest_ts wrong: %v", got[0].LatestTS)
	}
	if got[1].AgeSeconds == nil || *got[1].AgeSeconds != 0 {
		t.Fatalf("edge age = %v, want 0", got[1].AgeSeconds)
	}
	if got[0].SampleCount != 120 {
		t.Fatalf("sample_count = %d, want 120", got[0].SampleCount)
	}
}

func TestMapFreshnessEmptyIsNonNilSlice(t *testing.T) {
	if got := mapFreshness(nil, time.Now()); got == nil || len(got) != 0 {
		t.Fatalf("empty freshness must serialize as [], got %v", got)
	}
}

func TestControllerModeDefaultsToNormal(t *testing.T) {
	// Absence of a state frame is not evidence of degradation — staleness is the freshness
	// gate's concern, not this field's.
	if got := controllerMode(state.ControllerSnapshot{}); got != "normal" {
		t.Fatalf("mode = %q, want normal", got)
	}
	if got := controllerMode(state.ControllerSnapshot{Mode: "interlock"}); got != "interlock" {
		t.Fatalf("mode = %q, want interlock", got)
	}
}

func TestMapSensorFaultsIsOrderedAndScoped(t *testing.T) {
	t0 := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	snapshot := state.ControllerSnapshot{SensorFaults: map[state.FaultKey]state.SensorFault{
		{Component: "temperature"}:                      {Kind: "stuck", Since: t0},
		{Component: "soil_moisture", ZoneID: "bench-b"}: {Kind: "out_of_range", Since: t0},
		{Component: "soil_moisture", ZoneID: "bench-a"}: {Kind: "stuck", Since: t0},
	}}

	got := mapSensorFaults(snapshot)

	if len(got) != 3 {
		t.Fatalf("expected 3 faults, got %d", len(got))
	}
	// Stable ordering (metric, then zone) keeps the response comparable across cycles even
	// though the snapshot is a map.
	if got[0].Metric != "soil_moisture" || *got[0].ZoneID != "bench-a" {
		t.Fatalf("first fault = %+v", got[0])
	}
	if got[1].Metric != "soil_moisture" || *got[1].ZoneID != "bench-b" {
		t.Fatalf("second fault = %+v", got[1])
	}
	if got[2].Metric != "temperature" || got[2].ZoneID != nil {
		t.Fatalf("house-scoped fault must carry a null zone: %+v", got[2])
	}
	if got[2].Since != fmtTS(t0) {
		t.Fatalf("since = %q, want %q", got[2].Since, fmtTS(t0))
	}
}
