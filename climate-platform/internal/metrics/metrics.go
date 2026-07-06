// Package metrics is the platform's Prometheus instrumentation (operations §1): a
// private registry holding the platform-health collectors, exposed at /metrics for
// Prometheus to scrape. It measures the *services* — ingestion rate, API latency,
// reconciliation actions, per-controller connectivity, and datastore/background-job
// health — never the greenhouse climate the platform ingests.
//
// The recorder methods are nil-safe so components constructed without metrics (tests,
// the 2a trusted-network posture) can hold a nil *Metrics and call through harmlessly.
package metrics

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const namespace = "platform"

// Metrics owns the platform's Prometheus registry and its push-style collectors. The
// scrape-time collectors (fleet connectivity, datastore) are registered separately once
// their data sources exist — see RegisterFleet / RegisterDatastore / RegisterIngestDropped.
type Metrics struct {
	reg *prometheus.Registry

	ingestMessages          *prometheus.CounterVec
	httpDuration            *prometheus.HistogramVec
	reconcileActions        *prometheus.CounterVec
	connectivityTransitions *prometheus.CounterVec
}

// New builds the registry, registers the push collectors plus the stdlib Go/process
// collectors, and returns the handle to inject into the API server, ingester, and reconciler.
func New() *Metrics {
	m := &Metrics{
		reg: prometheus.NewRegistry(),
		ingestMessages: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace, Subsystem: "ingest", Name: "messages_total",
			Help: "Telemetry messages ingested from controllers, by stream.",
		}, []string{"stream"}),
		httpDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: namespace, Subsystem: "http", Name: "request_duration_seconds",
			Help:    "API request latency distribution, by method/route/status (P2-PERF-3).",
			Buckets: prometheus.DefBuckets,
		}, []string{"method", "route", "status"}),
		reconcileActions: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace, Subsystem: "reconcile", Name: "actions_total",
			Help: "Reconciliation actions taken, by action.",
		}, []string{"action"}),
		connectivityTransitions: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: namespace, Subsystem: "connectivity", Name: "transitions_total",
			Help: "Per-controller connectivity transitions, by new status.",
		}, []string{"status"}),
	}
	m.reg.MustRegister(
		m.ingestMessages,
		m.httpDuration,
		m.reconcileActions,
		m.connectivityTransitions,
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	return m
}

// Handler serves the Prometheus exposition for this registry. Wired at GET /metrics.
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{})
}

// IngestMessage counts one ingested telemetry message on the given stream
// (reading/actuator/event/state).
func (m *Metrics) IngestMessage(stream string) {
	if m == nil {
		return
	}
	m.ingestMessages.WithLabelValues(stream).Inc()
}

// ObserveHTTP records one served request's latency, labelled by method, route template,
// and status (errors are derivable from the status label).
func (m *Metrics) ObserveHTTP(method, route string, status int, d time.Duration) {
	if m == nil {
		return
	}
	m.httpDuration.WithLabelValues(method, route, strconv.Itoa(status)).Observe(d.Seconds())
}

// ReconcileAction counts one reconciliation action (apply/deferred/reassert/
// drift_detected/drift_corrected).
func (m *Metrics) ReconcileAction(action string) {
	if m == nil {
		return
	}
	m.reconcileActions.WithLabelValues(action).Inc()
}

// ConnectivityTransition counts one greenhouse connectivity change, by the new status.
func (m *Metrics) ConnectivityTransition(status string) {
	if m == nil {
		return
	}
	m.connectivityTransitions.WithLabelValues(status).Inc()
}

// RegisterIngestDropped exposes platform_ingest_dropped_total as a counter read from fn
// at scrape time (fn is the ingester's monotonic dropped-frame count).
func (m *Metrics) RegisterIngestDropped(fn func() float64) {
	if m == nil {
		return
	}
	m.reg.MustRegister(prometheus.NewCounterFunc(prometheus.CounterOpts{
		Namespace: namespace, Subsystem: "ingest", Name: "dropped_total",
		Help: "Telemetry frames shed under ingest backpressure (lag signal).",
	}, fn))
}

// RegisterFleet registers the scrape-time connectivity collector over the live fleet view.
func (m *Metrics) RegisterFleet(fleet fleetSnapshot) {
	if m == nil {
		return
	}
	m.reg.MustRegister(newFleetCollector(fleet))
}

// RegisterDatastore registers the scrape-time datastore collector: pool stats from the
// snapshot func plus TimescaleDB background-job health from jobs.
func (m *Metrics) RegisterDatastore(pool func() PoolStat, jobs JobStatser) {
	if m == nil {
		return
	}
	m.reg.MustRegister(newDBCollector(pool, jobs))
}
