"""Input data-quality & freshness gate (spec 07) — run before the twin and planner.

A stale, incomplete, faulted, or drifted telemetry window would let the planner produce a
confident plan over garbage. This gate is the precondition the Data Access component runs first:
on failure the optimizer degrades (holds the last applied bundle / the Phase 2 baseline) and
escalates with a canonical reason code, rather than planning on untrusted inputs.

**Check order** (first failure wins). The spec table is not a strict precedence, so the order is
chosen for defensibility and documented here:

1. ``contract_drift`` — identity / schema_version / zone-polarity: if the response is not for the
   greenhouse we asked for (or a shape we understand), nothing else is trustworthy. Persistent.
2. ``clock_mode_unsupported`` — a simulated greenhouse off 1× is outside the wall-clock envelope;
   a benign, expected hold.
3. ``input_stale`` — a present depended-on metric's latest reading is older than the threshold.
4. ``input_incomplete`` — a required metric/zone series is missing or its bucket coverage is low.
5. ``sensor_fault`` — the controller is degraded/interlocked, or a depended-on metric is faulted.
6. ``actuator_fault`` — an actuator's readback health is ``stuck`` / ``no_response``.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from .config import Settings
from .models import (
    REASON_CLASS,
    ActuatorHealth,
    ControllerMode,
    Metric,
    PlanningContext,
    ReasonClass,
    ReasonCode,
)

# Metrics/actuators that are zone-scoped (must carry a non-null zone_id); all others are
# greenhouse-scoped (must carry zone_id null). Used for the identity zone-polarity check.
_ZONE_SCOPED_METRICS = {Metric.SOIL_MOISTURE}
_ZONE_SCOPED_ACTUATORS = {"irrigation_valve"}

_INTERVAL_SECONDS = {"1h": 3600.0, "6h": 21600.0, "1d": 86400.0}

# Schema versions the optimizer understands (identity-consistency / drift check). A new major is
# an ADR event that updates this set alongside the models.
KNOWN_SCHEMA_VERSIONS: frozenset[int] = frozenset({1})


@dataclass(frozen=True)
class GateOutcome:
    """The gate's verdict: trusted, or held with a canonical reason code + triage class."""

    trusted: bool
    reason_code: ReasonCode | None = None
    reason_class: ReasonClass | None = None
    message: str | None = None

    @classmethod
    def ok(cls) -> GateOutcome:
        return cls(trusted=True)

    @classmethod
    def hold(cls, reason_code: ReasonCode, message: str) -> GateOutcome:
        return cls(
            trusted=False,
            reason_code=reason_code,
            reason_class=REASON_CLASS[reason_code],
            message=message,
        )


def _declared_zone_ids(ctx: PlanningContext) -> list[str]:
    """Irrigation zones the greenhouse declares, from the current setpoints bundle."""
    return [z.zone_id for z in ctx.setpoints.targets.zones]


def _depended_on(ctx: PlanningContext, settings: Settings) -> list[tuple[Metric, str | None]]:
    """(metric, zone_id) pairs the plan depends on: required climate metrics + per-zone soil."""
    pairs: list[tuple[Metric, str | None]] = [
        (m, None) for m in settings.data_quality.required_metrics
    ]
    pairs.extend((Metric.SOIL_MOISTURE, zid) for zid in _declared_zone_ids(ctx))
    return pairs


def _check_identity(ctx: PlanningContext, expected_greenhouse_id: str) -> GateOutcome | None:
    if ctx.greenhouse_id != expected_greenhouse_id:
        return GateOutcome.hold(
            ReasonCode.CONTRACT_DRIFT,
            f"response greenhouse_id {ctx.greenhouse_id!r} != requested {expected_greenhouse_id!r}",
        )
    if ctx.schema_version not in KNOWN_SCHEMA_VERSIONS:
        return GateOutcome.hold(
            ReasonCode.CONTRACT_DRIFT,
            f"unknown schema_version {ctx.schema_version}",
        )
    polarity = _check_zone_polarity(ctx)
    if polarity is not None:
        return GateOutcome.hold(ReasonCode.CONTRACT_DRIFT, polarity)
    return None


def _check_zone_polarity(ctx: PlanningContext) -> str | None:
    """A zone-scoped row must carry a non-null zone_id; a greenhouse-scoped row must be null."""

    def metric_bad(metric: Metric, zone_id: str | None) -> bool:
        zoned = metric in _ZONE_SCOPED_METRICS
        return zoned != (zone_id is not None)

    for series in ctx.telemetry:
        if metric_bad(series.metric, series.zone_id):
            return f"zone_id polarity violation on telemetry metric {series.metric.value}"
    for fresh in ctx.data_quality.freshness:
        if metric_bad(fresh.metric, fresh.zone_id):
            return f"zone_id polarity violation on freshness metric {fresh.metric.value}"
    for fault in ctx.data_quality.faults:
        if metric_bad(fault.metric, fault.zone_id):
            return f"zone_id polarity violation on fault metric {fault.metric.value}"
    for act in ctx.actuators:
        zoned = act.actuator.value in _ZONE_SCOPED_ACTUATORS
        if zoned != (act.zone_id is not None):
            return f"zone_id polarity violation on actuator {act.actuator.value}"
    return None


def _check_clock_mode(ctx: PlanningContext) -> GateOutcome | None:
    time_scale = ctx.data_quality.time_scale
    if time_scale is not None and abs(time_scale - 1.0) > 1e-9:
        return GateOutcome.hold(
            ReasonCode.CLOCK_MODE_UNSUPPORTED,
            f"simulation time_scale {time_scale} != 1.0 (wall-clock cadence out of envelope)",
        )
    return None


def _check_freshness(
    ctx: PlanningContext, depended_on: Iterable[tuple[Metric, str | None]], max_age_seconds: float
) -> GateOutcome | None:
    fresh_by_key = {(f.metric, f.zone_id): f for f in ctx.data_quality.freshness}
    for metric, zone_id in depended_on:
        entry = fresh_by_key.get((metric, zone_id))
        if entry is None:
            continue  # absence is a completeness concern, handled next
        if entry.age_seconds is None or entry.latest_ts is None:
            continue
        if entry.age_seconds > max_age_seconds:
            scope = f" zone {zone_id}" if zone_id else ""
            return GateOutcome.hold(
                ReasonCode.INPUT_STALE,
                f"{metric.value}{scope} latest reading {entry.age_seconds:.0f}s old "
                f"> {max_age_seconds:.0f}s",
            )
    return None


def _check_completeness(
    ctx: PlanningContext,
    depended_on: Iterable[tuple[Metric, str | None]],
    min_coverage: float,
) -> GateOutcome | None:
    series_by_key = {(s.metric, s.zone_id): s for s in ctx.telemetry}
    interval_seconds = _INTERVAL_SECONDS[ctx.interval.value]
    window_seconds = (ctx.to - ctx.from_).total_seconds()
    expected_buckets = max(1, round(window_seconds / interval_seconds))

    for metric, zone_id in depended_on:
        series = series_by_key.get((metric, zone_id))
        scope = f" zone {zone_id}" if zone_id else ""
        if series is None:
            return GateOutcome.hold(
                ReasonCode.INPUT_INCOMPLETE, f"required metric {metric.value}{scope} missing"
            )
        non_empty = sum(1 for b in series.buckets if b.count > 0)
        coverage = non_empty / expected_buckets
        if coverage < min_coverage:
            return GateOutcome.hold(
                ReasonCode.INPUT_INCOMPLETE,
                f"{metric.value}{scope} coverage {coverage:.2f} < {min_coverage:.2f} "
                f"({non_empty}/{expected_buckets} buckets)",
            )
    return None


def _check_health(
    ctx: PlanningContext, depended_on: Iterable[tuple[Metric, str | None]]
) -> GateOutcome | None:
    mode = ctx.data_quality.controller_mode
    if mode is not ControllerMode.NORMAL:
        return GateOutcome.hold(ReasonCode.SENSOR_FAULT, f"controller mode {mode.value}")

    depended = set(depended_on)
    for fault in ctx.data_quality.faults:
        if (fault.metric, fault.zone_id) in depended:
            scope = f" zone {fault.zone_id}" if fault.zone_id else ""
            return GateOutcome.hold(
                ReasonCode.SENSOR_FAULT,
                f"{fault.metric.value}{scope} sensor fault: {fault.kind.value}",
            )

    for act in ctx.actuators:
        if act.health is not ActuatorHealth.OK:
            scope = f" zone {act.zone_id}" if act.zone_id else ""
            return GateOutcome.hold(
                ReasonCode.ACTUATOR_FAULT,
                f"{act.actuator.value}{scope} actuator {act.health.value}",
            )
    return None


def evaluate_input_gate(
    ctx: PlanningContext,
    settings: Settings,
    *,
    expected_greenhouse_id: str,
) -> GateOutcome:
    """Run the input-quality gate; return the first failing check, or ``ok`` if all pass."""
    identity = _check_identity(ctx, expected_greenhouse_id)
    if identity is not None:
        return identity

    clock = _check_clock_mode(ctx)
    if clock is not None:
        return clock

    depended_on = _depended_on(ctx, settings)
    max_age_seconds = settings.data_quality.max_telemetry_age_minutes * 60.0

    stale = _check_freshness(ctx, depended_on, max_age_seconds)
    if stale is not None:
        return stale

    incomplete = _check_completeness(ctx, depended_on, settings.data_quality.min_history_coverage)
    if incomplete is not None:
        return incomplete

    health = _check_health(ctx, depended_on)
    if health is not None:
        return health

    return GateOutcome.ok()
