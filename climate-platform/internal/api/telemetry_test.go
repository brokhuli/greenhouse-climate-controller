package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
)

func TestGroupSeries(t *testing.T) {
	bench := "bench-a"
	base := time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC)
	rs := []domain.Reading{
		{Metric: "temperature", Value: 20, TS: base},
		{Metric: "temperature", Value: 21, TS: base.Add(time.Second)},
		{Metric: "soil_moisture", ZoneID: &bench, Value: 0.4, TS: base},
		{Metric: "soil_moisture", ZoneID: &bench, Value: 0.41, TS: base.Add(time.Second)},
	}
	series := groupSeries(rs)
	if len(series) != 2 {
		t.Fatalf("want 2 series, got %d", len(series))
	}
	if series[0].Metric != "temperature" || series[0].ZoneID != nil || len(series[0].Readings) != 2 {
		t.Fatalf("temperature series wrong: %+v", series[0])
	}
	if series[1].Metric != "soil_moisture" || series[1].ZoneID == nil || *series[1].ZoneID != "bench-a" {
		t.Fatalf("soil series wrong: %+v", series[1])
	}
}

func TestGroupAnalytics(t *testing.T) {
	base := time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC)
	rs := []store.AnalyticsRow{
		{Metric: "temperature", BucketStart: base, Min: 19, Max: 22, Avg: 20.5, Count: 60},
		{Metric: "temperature", BucketStart: base.Add(time.Hour), Min: 20, Max: 23, Avg: 21.5, Count: 60},
		{Metric: "co2", BucketStart: base, Min: 800, Max: 1000, Avg: 900, Count: 60},
	}
	series := groupAnalytics(rs)
	if len(series) != 2 {
		t.Fatalf("want 2 series, got %d", len(series))
	}
	if series[0].Metric != "temperature" || len(series[0].Buckets) != 2 {
		t.Fatalf("temperature analytics wrong: %+v", series[0])
	}
	if series[1].Metric != "co2" || len(series[1].Buckets) != 1 {
		t.Fatalf("co2 analytics wrong: %+v", series[1])
	}
}

func TestSparklineBucketSQL(t *testing.T) {
	cases := []struct {
		name   string
		window time.Duration
		want   string
	}{
		{"15m targets ~40 points", 15 * time.Minute, "22 seconds"},
		{"tiny window clamps to floor", 30 * time.Second, "10 seconds"},
		{"zero window clamps to floor", 0, "10 seconds"},
		{"huge window clamps to ceiling", 48 * time.Hour, "600 seconds"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sparklineBucketSQL(tc.window); got != tc.want {
				t.Fatalf("sparklineBucketSQL(%s) = %q, want %q", tc.window, got, tc.want)
			}
		})
	}
}

func TestGroupFleetSparklines(t *testing.T) {
	base := time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC)
	rows := []store.FleetSparklineRow{
		{GreenhouseID: "gh-a", BucketStart: base, Avg: 20.5},
		{GreenhouseID: "gh-a", BucketStart: base.Add(30 * time.Second), Avg: 21.0},
		{GreenhouseID: "gh-b", BucketStart: base, Avg: 18.2},
	}
	series := groupFleetSparklines(rows)
	if len(series) != 2 {
		t.Fatalf("want 2 series, got %d", len(series))
	}
	if series[0].GreenhouseID != "gh-a" || len(series[0].Readings) != 2 || series[0].Readings[0].Value != 20.5 {
		t.Fatalf("gh-a series wrong: %+v", series[0])
	}
	if series[1].GreenhouseID != "gh-b" || len(series[1].Readings) != 1 {
		t.Fatalf("gh-b series wrong: %+v", series[1])
	}
}

func TestMapActuators(t *testing.T) {
	observed := 58.0
	base := time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC)
	out := mapActuators([]domain.ActuatorSample{{Actuator: "fans", Commanded: 60, Observed: &observed, TS: base}})
	if len(out) != 1 || out[0].Actuator != "fans" || out[0].Commanded != 60 || out[0].Observed == nil || *out[0].Observed != 58 {
		t.Fatalf("unexpected actuator mapping: %+v", out)
	}
}

func TestParseWindowParam(t *testing.T) {
	e := echo.New()
	parse := func(raw string) (time.Duration, *valError) {
		target := "/"
		if raw != "" {
			target = "/?window=" + raw
		}
		req := httptest.NewRequest(http.MethodGet, target, nil)
		return parseWindowParam(e.NewContext(req, httptest.NewRecorder()))
	}

	if d, verr := parse(""); verr != nil || d != time.Hour {
		t.Fatalf("omitted window = %v (verr %v), want default 1h", d, verr)
	}
	for raw, want := range map[string]time.Duration{
		"15m": 15 * time.Minute,
		"30m": 30 * time.Minute,
		"1h":  time.Hour,
		"6h":  6 * time.Hour,
		"24h": 24 * time.Hour,
	} {
		if d, verr := parse(raw); verr != nil || d != want {
			t.Fatalf("window %q = %v (verr %v), want %v", raw, d, verr, want)
		}
	}
	if _, verr := parse("7d"); verr == nil || verr.Field != "window" {
		t.Fatalf("retired window 7d: want valError on field \"window\", got %+v", verr)
	}
}
