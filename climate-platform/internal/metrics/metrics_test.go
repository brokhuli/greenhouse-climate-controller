package metrics

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
)

func TestRecordersIncrement(t *testing.T) {
	m := New()
	m.IngestMessage("reading")
	m.IngestMessage("reading")
	m.IngestMessage("actuator")
	m.ReconcileAction("apply")
	m.ConnectivityTransition("offline")
	m.ObserveHTTP(http.MethodGet, "/api/greenhouses", 200, 5*time.Millisecond)

	if got := testutil.ToFloat64(m.ingestMessages.WithLabelValues("reading")); got != 2 {
		t.Errorf("ingest reading = %v, want 2", got)
	}
	if got := testutil.ToFloat64(m.ingestMessages.WithLabelValues("actuator")); got != 1 {
		t.Errorf("ingest actuator = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.reconcileActions.WithLabelValues("apply")); got != 1 {
		t.Errorf("reconcile apply = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.connectivityTransitions.WithLabelValues("offline")); got != 1 {
		t.Errorf("connectivity offline = %v, want 1", got)
	}
	// A histogram vec with one observed label set collects exactly one series.
	if got := testutil.CollectAndCount(m.httpDuration); got != 1 {
		t.Errorf("http series = %d, want 1", got)
	}
}

// A nil *Metrics must be safe to call through (the 2a unauthenticated posture / tests pass nil).
func TestNilMetricsIsSafe(t *testing.T) {
	var m *Metrics
	m.IngestMessage("reading")
	m.ObserveHTTP(http.MethodGet, "/x", 200, time.Millisecond)
	m.ReconcileAction("apply")
	m.ConnectivityTransition("online")
	m.RegisterFleet(fakeFleet{})
	m.RegisterDatastore(func() PoolStat { return PoolStat{} }, fakeJobs(nil))
	m.RegisterIngestDropped(func() float64 { return 0 })
}

func TestHandlerServesExposition(t *testing.T) {
	m := New()
	m.IngestMessage("reading")

	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "platform_ingest_messages_total") {
		t.Errorf("exposition missing platform_ingest_messages_total:\n%s", rec.Body.String())
	}
}

func TestFleetCollector(t *testing.T) {
	fleet := fakeFleet{
		"gh-a": {Status: domain.StatusOnline},
		"gh-b": {Status: domain.StatusOffline},
	}
	const want = `
# HELP platform_greenhouse_connectivity Per-controller connectivity as the platform observes it (1 for the current status).
# TYPE platform_greenhouse_connectivity gauge
platform_greenhouse_connectivity{greenhouse_id="gh-a",status="online"} 1
platform_greenhouse_connectivity{greenhouse_id="gh-b",status="offline"} 1
`
	if err := testutil.CollectAndCompare(newFleetCollector(fleet), strings.NewReader(want), "platform_greenhouse_connectivity"); err != nil {
		t.Error(err)
	}
}

func TestDBCollectorPoolStats(t *testing.T) {
	c := newDBCollector(
		func() PoolStat { return PoolStat{Acquired: 1, Idle: 2, Total: 3, Max: 10, Constructing: 0} },
		fakeJobs(nil),
	)
	const want = `
# HELP platform_db_pool_connections pgx connection-pool counts, by state (acquired/idle/total/max/constructing).
# TYPE platform_db_pool_connections gauge
platform_db_pool_connections{state="acquired"} 1
platform_db_pool_connections{state="constructing"} 0
platform_db_pool_connections{state="idle"} 2
platform_db_pool_connections{state="max"} 10
platform_db_pool_connections{state="total"} 3
`
	if err := testutil.CollectAndCompare(c, strings.NewReader(want), "platform_db_pool_connections"); err != nil {
		t.Error(err)
	}
}

func TestDBCollectorJobHealth(t *testing.T) {
	c := newDBCollector(
		func() PoolStat { return PoolStat{} },
		fakeJobs{{Name: "prune_setpoint_revisions", JobID: 1000, TotalFailures: 2, LastRunSuccess: true}},
	)
	const want = `
# HELP platform_bgjob_total_failures Total failures recorded for a TimescaleDB background job.
# TYPE platform_bgjob_total_failures gauge
platform_bgjob_total_failures{id="1000",job="prune_setpoint_revisions"} 2
`
	if err := testutil.CollectAndCompare(c, strings.NewReader(want), "platform_bgjob_total_failures"); err != nil {
		t.Error(err)
	}
}

// --- fakes ---

type fakeFleet map[string]state.Live

func (f fakeFleet) All() map[string]state.Live { return f }

type fakeJobs []store.JobStat

func (f fakeJobs) JobStats(context.Context) ([]store.JobStat, error) { return f, nil }
