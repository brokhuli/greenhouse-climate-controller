//go:build integration

// Package test holds DB-backed integration tests, gated behind the `integration` build
// tag so the default `go test ./...` unit gate stays Docker-free. Run with:
//
//	go test -tags integration ./test/...
//
// It spins up a real TimescaleDB and exercises migrations, the hypertable/retention
// setup, the registry, and the telemetry range/analytics queries end to end.
package test

import (
	"context"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
)

func newTimescale(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	ctr, err := tcpostgres.Run(ctx, "timescale/timescaledb:latest-pg16",
		tcpostgres.WithDatabase("greenhouse"),
		tcpostgres.WithUsername("greenhouse"),
		tcpostgres.WithPassword("secret"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).WithStartupTimeout(90*time.Second)),
	)
	if err != nil {
		t.Fatalf("start timescaledb: %v", err)
	}
	t.Cleanup(func() { _ = ctr.Terminate(ctx) })
	dsn, err := ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("connection string: %v", err)
	}
	return dsn
}

func TestStoreRoundTrip(t *testing.T) {
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

	// Registry.
	if err := st.Register(ctx, store.Registration{
		ID: "gh-a", DisplayName: "House A",
		Endpoint: store.Endpoint{RESTBaseURL: "http://gh-a:8080", MQTTTopicRoot: "gh/gh-a"},
	}); err != nil {
		t.Fatalf("register: %v", err)
	}
	if err := st.Register(ctx, store.Registration{ID: "gh-a", DisplayName: "dup",
		Endpoint: store.Endpoint{RESTBaseURL: "x", MQTTTopicRoot: "y"}}); err != store.ErrAlreadyExists {
		t.Fatalf("duplicate register err = %v, want ErrAlreadyExists", err)
	}
	ghs, err := st.ListGreenhouses(ctx)
	if err != nil || len(ghs) != 1 || ghs[0].ID != "gh-a" {
		t.Fatalf("list = %+v err=%v", ghs, err)
	}

	// Telemetry: insert a minute of temperature, then range + analytics.
	base := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	var readings []domain.Reading
	for n := 0; n < 60; n++ {
		readings = append(readings, domain.Reading{
			GreenhouseID: "gh-a", Metric: "temperature", Value: 20 + float64(n%5), Unit: "°C",
			TS: base.Add(time.Duration(n) * time.Second),
		})
	}
	if err := st.InsertReadings(ctx, readings); err != nil {
		t.Fatalf("insert readings: %v", err)
	}

	rdg, _, err := st.TelemetryRange(ctx, "gh-a", base.Add(-time.Minute), base.Add(2*time.Minute))
	if err != nil || len(rdg) != 60 {
		t.Fatalf("range = %d readings err=%v", len(rdg), err)
	}

	rows, err := st.Analytics(ctx, "gh-a", base.Add(-time.Minute), base.Add(2*time.Minute), nil, "5 minutes")
	if err != nil || len(rows) == 0 {
		t.Fatalf("analytics = %+v err=%v", rows, err)
	}
	if rows[0].Count == 0 || rows[0].Max < rows[0].Min {
		t.Fatalf("bad bucket: %+v", rows[0])
	}

	// Events.
	if err := st.InsertEvent(ctx, domain.Event{GreenhouseID: "gh-a", TS: base, Kind: "setpoint_edit", Severity: "info", Message: "edit", Source: "operator"}); err != nil {
		t.Fatalf("insert event: %v", err)
	}
	evs, err := st.ListEvents(ctx, store.EventFilter{})
	if err != nil || len(evs) != 1 || evs[0].Kind != "setpoint_edit" {
		t.Fatalf("events = %+v err=%v", evs, err)
	}

	// Retire.
	found, err := st.Retire(ctx, "gh-a")
	if err != nil || !found {
		t.Fatalf("retire found=%v err=%v", found, err)
	}
}

func TestFleetSparklines(t *testing.T) {
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

	// Two greenhouses whose simulated clocks are 3h apart: the window must anchor to each
	// (greenhouse, metric) pair's own latest reading, not a single fleet-wide span (which couldn't
	// cover both).
	bench := "bench-a"
	aLatest := time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC)
	bLatest := aLatest.Add(3 * time.Hour)
	reading := func(id, metric string, value float64, ts time.Time) domain.Reading {
		return domain.Reading{GreenhouseID: id, Metric: metric, Value: value, Unit: domain.MetricUnit(metric), TS: ts}
	}
	var readings []domain.Reading
	// gh-a: 90 min of temperature + humidity history, so its oldest 30 min fall outside the 1h window.
	for m := 90; m >= 0; m -= 2 {
		readings = append(readings, reading("gh-a", "temperature", 21, aLatest.Add(-time.Duration(m)*time.Minute)))
		readings = append(readings, reading("gh-a", "humidity", 60, aLatest.Add(-time.Duration(m)*time.Minute)))
	}
	// gh-b: 30 min of temperature only (no humidity), ending 3h after gh-a's latest reading.
	for m := 30; m >= 0; m -= 2 {
		readings = append(readings, reading("gh-b", "temperature", 21, bLatest.Add(-time.Duration(m)*time.Minute)))
	}
	// A zone-scoped reading that must NOT leak into the house-level sparkline.
	readings = append(readings, domain.Reading{
		GreenhouseID: "gh-a", Metric: "soil_moisture", ZoneID: &bench, Value: 0.42, Unit: "VWC", TS: aLatest,
	})
	if err := st.InsertReadings(ctx, readings); err != nil {
		t.Fatalf("insert readings: %v", err)
	}

	rows, err := st.FleetSparklines(ctx, "3600 seconds", []string{"temperature", "humidity"}, "60 seconds")
	if err != nil {
		t.Fatalf("fleet sparklines: %v", err)
	}
	type seriesKey struct{ id, metric string }
	buckets := map[seriesKey][]time.Time{}
	for _, row := range rows {
		if row.Metric == "soil_moisture" {
			t.Fatalf("zone-scoped soil_moisture leaked into fleet sparklines: %+v", row)
		}
		key := seriesKey{row.GreenhouseID, row.Metric}
		buckets[key] = append(buckets[key], row.BucketStart.UTC())
	}
	// gh-a carries both requested metrics; gh-b only temperature (no humidity was inserted, so a
	// metric with no data is simply absent rather than empty).
	for _, key := range []seriesKey{{"gh-a", "temperature"}, {"gh-a", "humidity"}, {"gh-b", "temperature"}} {
		if len(buckets[key]) == 0 {
			t.Fatalf("%+v: no buckets in its anchored window", key)
		}
	}
	if got := buckets[seriesKey{"gh-b", "humidity"}]; len(got) != 0 {
		t.Fatalf("gh-b should have no humidity buckets, got %v", got)
	}
	// Each (greenhouse, metric)'s buckets fall within its own (latest-1h, latest] — per-pair anchoring.
	anchor := map[string]time.Time{"gh-a": aLatest, "gh-b": bLatest}
	for key, bs := range buckets {
		floor := anchor[key.id].Add(-time.Hour)
		for _, b := range bs {
			if !b.After(floor) || b.After(anchor[key.id]) {
				t.Fatalf("%+v: bucket %s outside anchored window (%s, %s]", key, b, floor, anchor[key.id])
			}
		}
	}

	// LatestReadingTS anchors to stored time per greenhouse; unknown greenhouses report no data.
	if ts, ok, err := st.LatestReadingTS(ctx, "gh-b"); err != nil || !ok || !ts.UTC().Equal(bLatest) {
		t.Fatalf("LatestReadingTS(gh-b)=%v ok=%v err=%v, want %v ok=true", ts, ok, err, bLatest)
	}
	if _, ok, err := st.LatestReadingTS(ctx, "ghost"); err != nil || ok {
		t.Fatalf("LatestReadingTS(unknown) ok=%v err=%v, want ok=false", ok, err)
	}
}
