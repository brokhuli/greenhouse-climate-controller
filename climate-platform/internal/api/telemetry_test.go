package api

import (
	"testing"
	"time"

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

func TestMapActuators(t *testing.T) {
	observed := 58.0
	base := time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC)
	out := mapActuators([]domain.ActuatorSample{{Actuator: "fans", Commanded: 60, Observed: &observed, TS: base}})
	if len(out) != 1 || out[0].Actuator != "fans" || out[0].Commanded != 60 || out[0].Observed == nil || *out[0].Observed != 58 {
		t.Fatalf("unexpected actuator mapping: %+v", out)
	}
}
