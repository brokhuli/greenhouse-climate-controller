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
