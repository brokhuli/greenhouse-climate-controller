package metrics

import (
	"context"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
)

// fleetSnapshot is the subset of *state.Fleet the connectivity collector reads.
type fleetSnapshot interface {
	All() map[string]state.Live
}

// PoolStat is a point-in-time snapshot of pgx pool counters. pgxpool.Stat has unexported
// fields, so main adapts db.Pool().Stat() into this so the collector stays unit-testable.
type PoolStat struct {
	Acquired     int32
	Idle         int32
	Total        int32
	Max          int32
	Constructing int32
}

// JobStatser reports TimescaleDB background-job health (implemented by *store.Store).
type JobStatser interface {
	JobStats(ctx context.Context) ([]store.JobStat, error)
}

// fleetCollector reports current per-controller connectivity at scrape time, reading the
// live fleet view directly so the gauge can never drift from the source of truth.
type fleetCollector struct {
	fleet fleetSnapshot
	desc  *prometheus.Desc
}

func newFleetCollector(fleet fleetSnapshot) *fleetCollector {
	return &fleetCollector{
		fleet: fleet,
		desc: prometheus.NewDesc(
			namespace+"_greenhouse_connectivity",
			"Per-controller connectivity as the platform observes it (1 for the current status).",
			[]string{"greenhouse_id", "status"}, nil,
		),
	}
}

func (c *fleetCollector) Describe(ch chan<- *prometheus.Desc) { ch <- c.desc }

func (c *fleetCollector) Collect(ch chan<- prometheus.Metric) {
	for id, live := range c.fleet.All() {
		ch <- prometheus.MustNewConstMetric(c.desc, prometheus.GaugeValue, 1, id, string(live.Status))
	}
}

// dbCollector reports datastore health at scrape time: pgx connection-pool usage plus the
// health of the TimescaleDB retention/prune background jobs (operations §1, datastore).
type dbCollector struct {
	pool func() PoolStat
	jobs JobStatser

	poolDesc        *prometheus.Desc
	jobSuccessDesc  *prometheus.Desc
	jobFailuresDesc *prometheus.Desc
	jobLastRunDesc  *prometheus.Desc
}

func newDBCollector(pool func() PoolStat, jobs JobStatser) *dbCollector {
	return &dbCollector{
		pool: pool,
		jobs: jobs,
		poolDesc: prometheus.NewDesc(
			namespace+"_db_pool_connections",
			"pgx connection-pool counts, by state (acquired/idle/total/max/constructing).",
			[]string{"state"}, nil,
		),
		jobSuccessDesc: prometheus.NewDesc(
			namespace+"_bgjob_last_success_timestamp_seconds",
			"Unix time of a TimescaleDB background job's last successful finish (0 if never).",
			[]string{"job", "id"}, nil,
		),
		jobFailuresDesc: prometheus.NewDesc(
			namespace+"_bgjob_total_failures",
			"Total failures recorded for a TimescaleDB background job.",
			[]string{"job", "id"}, nil,
		),
		jobLastRunDesc: prometheus.NewDesc(
			namespace+"_bgjob_last_run_success",
			"Whether a TimescaleDB background job's most recent run succeeded (1) or not (0).",
			[]string{"job", "id"}, nil,
		),
	}
}

func (c *dbCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.poolDesc
	ch <- c.jobSuccessDesc
	ch <- c.jobFailuresDesc
	ch <- c.jobLastRunDesc
}

func (c *dbCollector) Collect(ch chan<- prometheus.Metric) {
	st := c.pool()
	pool := func(state string, v float64) {
		ch <- prometheus.MustNewConstMetric(c.poolDesc, prometheus.GaugeValue, v, state)
	}
	pool("acquired", float64(st.Acquired))
	pool("idle", float64(st.Idle))
	pool("total", float64(st.Total))
	pool("max", float64(st.Max))
	pool("constructing", float64(st.Constructing))

	// Job health is best-effort: a query error still leaves the pool gauges above.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	stats, err := c.jobs.JobStats(ctx)
	if err != nil {
		return
	}
	for _, js := range stats {
		id := strconv.FormatInt(js.JobID, 10)
		var lastSuccess float64
		if js.LastSuccess != nil {
			lastSuccess = float64(js.LastSuccess.Unix())
		}
		var lastRun float64
		if js.LastRunSuccess {
			lastRun = 1
		}
		ch <- prometheus.MustNewConstMetric(c.jobSuccessDesc, prometheus.GaugeValue, lastSuccess, js.Name, id)
		ch <- prometheus.MustNewConstMetric(c.jobFailuresDesc, prometheus.GaugeValue, float64(js.TotalFailures), js.Name, id)
		ch <- prometheus.MustNewConstMetric(c.jobLastRunDesc, prometheus.GaugeValue, lastRun, js.Name, id)
	}
}
