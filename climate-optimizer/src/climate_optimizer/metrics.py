"""Prometheus optimizer-health metrics (spec 12 §Observability, spec 09 §Health & cadence watchdog).

The metrics sibling of ``/health``: where the health endpoint answers "is the loop alive right now",
these make the same stall and overrun conditions **graphable and alertable** in the platform's shared
Grafana — last-successful-cycle age, cycle duration, twin divergence, planner failover, and the
applied-vs-escalated split. Exposed unauthenticated on ``GET /metrics``, joining Prometheus as a
third scrape target alongside the platform and each controller.

Collectors live in the default registry so ``prometheus_client.generate_latest()`` picks them up.
"""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

# Cycle throughput split by the outcome the gates reached — the applied-vs-escalated signal.
CYCLES_TOTAL = Counter(
    "optimizer_cycles_total",
    "Planning cycles completed, by greenhouse and outcome status.",
    labelnames=("greenhouse_id", "status"),
)

# Why cycles are being held, so a persistent fault is visible without reading the escalation queue.
ESCALATIONS_TOTAL = Counter(
    "optimizer_escalations_total",
    "Escalations raised, by greenhouse and canonical reason code.",
    labelnames=("greenhouse_id", "reason_code"),
)

# P3-PERF-2: the planning cycle is bounded at cycle_timeout_seconds; buckets straddle that bound.
CYCLE_DURATION_SECONDS = Histogram(
    "optimizer_cycle_duration_seconds",
    "Wall-clock duration of a planning cycle.",
    labelnames=("greenhouse_id",),
    buckets=(0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 90.0, 120.0),
)

TWIN_DIVERGENCE_TOTAL = Counter(
    "optimizer_twin_divergence_total",
    "Twin robustness failures, by greenhouse and kind (diverged / fidelity_fault).",
    labelnames=("greenhouse_id", "kind"),
)

PLANNER_FAILOVER_TOTAL = Counter(
    "optimizer_planner_failover_total",
    "Planner invocations served by the configured fallback backend.",
    labelnames=("greenhouse_id",),
)

PLANNER_SUPPRESSED_TOTAL = Counter(
    "optimizer_planner_suppressed_total",
    "Cycles where the state-change gate suppressed the LLM call and extended the plan.",
    labelnames=("greenhouse_id",),
)

LAST_SUCCESSFUL_CYCLE_TIMESTAMP = Gauge(
    "optimizer_last_successful_cycle_timestamp_seconds",
    "Unix timestamp of the last cycle that applied a plan (0 before the first).",
)

OPEN_ESCALATIONS = Gauge(
    "optimizer_open_escalations",
    "Current open-escalation backlog awaiting operator review.",
)

ENABLED = Gauge(
    "optimizer_enabled",
    "1 while planning is enabled, 0 while the service is in read-only mode.",
)
