"""Constraint engine + application gate (spec 06) — the deterministic guardrails on plan output.

The engine validates the setpoints the optimizer would write against the two checks it can make
deterministically from data in hand — the crop-safe bounds delivered in the planning context and the
bundle's own self-consistency — plus the structural precondition that ``immediate_setpoints`` equals
``trajectory[0].setpoints`` field-for-field. The application gate then combines the engine verdict with
the confidence threshold to decide apply / escalate / extend. It never checks actuator ranges,
interlocks, or reachability: those are controller-owned (spec 06 §1).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import timedelta

from annotated_types import Ge, Le

from ..models import (
    Bound,
    Horizon,
    OptimizerPlan,
    OutcomeStatus,
    ReasonCode,
    Setpoints,
    SetpointsPatch,
    StageBounds,
)

# Future refined-trajectory change points are aligned to the hourly planning grid (spec 05 §2).
_TRAJECTORY_STEP = timedelta(hours=1)

# Scalar climate targets carrying an optional crop-safe Bound (spec 06 §1 / StageBounds).
_BOUNDED_SCALARS: tuple[str, ...] = (
    "temperature_day_c",
    "temperature_night_c",
    "humidity_low_pct",
    "humidity_high_pct",
    "humidity_deadband_pct",
    "co2_target_ppm",
    "co2_vent_interlock_threshold_pct",
    "vpd_target_kpa",
    "dli_target_mol",
)
_ZONE_BOUNDED: tuple[str, ...] = (
    "moisture_low_threshold",
    "moisture_high_threshold",
    "drain_period_secs",
)

# Bounded targets whose type is integer — the clamped crop-safe edge is rounded back to an int so the
# rebuilt patch still validates (``co2_target_ppm`` / zone ``drain_period_secs``).
_INT_SCALARS: frozenset[str] = frozenset({"co2_target_ppm"})
_INT_ZONE: frozenset[str] = frozenset({"drain_period_secs"})


@dataclass(frozen=True)
class ConstraintResult:
    """Verdict of the deterministic constraint engine."""

    ok: bool
    reason_code: ReasonCode | None = None
    message: str | None = None

    @classmethod
    def passed(cls) -> ConstraintResult:
        return cls(ok=True)

    @classmethod
    def violation(cls, message: str) -> ConstraintResult:
        return cls(ok=False, reason_code=ReasonCode.CONSTRAINT_VIOLATION, message=message)


@dataclass(frozen=True)
class ApplicationDecision:
    """The application gate's decision for a cycle."""

    status: OutcomeStatus
    reason_code: ReasonCode | None = None
    message: str | None = None


@dataclass(frozen=True)
class ClampResult:
    """A patch pulled back inside the crop-safe envelope, and which fields moved."""

    patch: SetpointsPatch
    clamped_fields: tuple[str, ...]


def _within(value: float, bound: Bound) -> bool:
    return bound.min <= value <= bound.max


def _clamp(value: float, bound: Bound) -> float:
    """Pull a value to the nearest crop-safe edge (the bound *is* the safe value)."""
    return min(max(value, bound.min), bound.max)


def clamp_to_bounds(patch: SetpointsPatch, bounds: StageBounds | None) -> ClampResult:
    """Return ``patch`` with every out-of-bounds target pulled to its crop-safe edge (spec 06 §1).

    A small model occasionally proposes a target just outside its envelope. Rather than discard the
    whole cycle as a ``constraint_violation`` — control lost over a single stray field — we clamp the
    field to the boundary and apply: the crop-safe edge is safe by definition, and Phase 2's write
    path still backstops it. Only the bounded scalar/zone targets are clamped; cross-field
    consistency (``humidity_low ≤ humidity_high`` …) is *not* repaired here — a self-contradictory
    bundle is a genuine model error and still escalates. Returns the original patch unchanged (and an
    empty ``clamped_fields``) when nothing was out of range or there are no bounds.
    """
    if bounds is None:
        return ClampResult(patch, ())

    data = patch.model_dump(exclude_unset=True)
    clamped: list[str] = []

    for field in _BOUNDED_SCALARS:
        value = data.get(field)
        bound = getattr(bounds, field)
        if value is None or bound is None or _within(float(value), bound):
            continue
        edge = _clamp(float(value), bound)
        data[field] = int(round(edge)) if field in _INT_SCALARS else edge
        clamped.append(field)

    zones = data.get("zones")
    if zones and bounds.zones is not None:
        for zone in zones:
            for field in _ZONE_BOUNDED:
                value = zone.get(field)
                bound = getattr(bounds.zones, field)
                if value is None or bound is None or _within(float(value), bound):
                    continue
                edge = _clamp(float(value), bound)
                zone[field] = int(round(edge)) if field in _INT_ZONE else edge
                clamped.append(f"zones[{zone['zone_id']}].{field}")

    if not clamped:
        return ClampResult(patch, ())
    return ClampResult(SetpointsPatch(**data), tuple(clamped))


def _physical_range(field: str) -> tuple[float | None, float | None]:
    """The hard physical ``[ge, le]`` for a setpoint field, read from its ``SetpointsPatch`` metadata.

    Reused so the delta path never duplicates the physical limits already declared on the model (a
    field may have only a lower bound, e.g. ``vpd_target_kpa`` ge=0, so either edge can be ``None``).
    """
    lo: float | None = None
    hi: float | None = None
    for meta in SetpointsPatch.model_fields[field].metadata:
        # annotated-types types ``ge``/``le`` as SupportsGe/SupportsLe; our fields declare numeric
        # literals, so the float() is safe at runtime.
        if isinstance(meta, Ge):
            lo = float(meta.ge)  # type: ignore[arg-type]
        elif isinstance(meta, Le):
            hi = float(meta.le)  # type: ignore[arg-type]
    return lo, hi


def apply_adjustments(current: Setpoints, deltas: Mapping[str, float]) -> SetpointsPatch:
    """Turn per-field *deltas* into an absolute patch: ``current + delta``, held to each field's range.

    Rec 1 (delta action space): the model proposes how much to *change* each target, and the absolute
    setpoint is ``current + delta``. Clamping the result into the field's **physical** range (from the
    ``SetpointsPatch`` constraints) guarantees the rebuilt patch always validates — even an unbounded
    field nudged past a hard limit (e.g. ``humidity_high_pct`` + delta > 100). Crop-safe clamping is a
    separate, operator-visible step (:func:`clamp_to_bounds`); this one only keeps the value constructible.
    ``deltas`` is expected pre-filtered to the fields actually moved (non-null, non-zero).
    """
    values: dict[str, float | int] = {}
    for field, delta in deltas.items():
        target = float(getattr(current, field)) + float(delta)
        lo, hi = _physical_range(field)
        if lo is not None:
            target = max(target, lo)
        if hi is not None:
            target = min(target, hi)
        values[field] = int(round(target)) if field in _INT_SCALARS else target
    return SetpointsPatch(**values)


def _patch_signature(patch: SetpointsPatch) -> tuple[tuple[tuple[str, object], ...], object]:
    """A comparable, zone-order-independent view of a patch's *set* fields (for equality)."""
    data = patch.model_dump(exclude_unset=True)
    zones = data.pop("zones", None)
    zone_sig = None if zones is None else {z["zone_id"]: tuple(sorted(z.items())) for z in zones}
    return tuple(sorted(data.items())), zone_sig


def check_immediate_matches_trajectory(plan: OptimizerPlan) -> str | None:
    """Enforce ``immediate_setpoints ≡ trajectory[0].setpoints`` field-for-field (spec 06 §1)."""
    if _patch_signature(plan.immediate_setpoints) != _patch_signature(plan.trajectory[0].setpoints):
        return "immediate_setpoints does not equal trajectory[0].setpoints field-for-field"
    return None


def check_trajectory_timing(plan: OptimizerPlan, horizon: Horizon) -> str | None:
    """Validate sparse, hour-aligned change points anchored at the planning horizon.

    The load-bearing invariant is that ``trajectory[0]`` is the bundle applied *this* cadence, so it
    must sit at ``horizon.start``. Later points are optional future changes: they must be strictly
    ordered, on whole-hour offsets from that start, and within the horizon. We do *not* require the
    tail to reach ``horizon.end`` — beyond the head the trajectory is surfaced only, never replayed.
    """
    points = plan.trajectory
    if points[0].at != horizon.start:
        return f"trajectory[0].at {points[0].at.isoformat()} is not horizon.start {horizon.start.isoformat()}"
    previous = points[0].at
    for index, point in enumerate(points[1:], start=1):
        if point.at <= previous:
            return f"trajectory[{index}].at {point.at.isoformat()} is not after the previous point"
        if (point.at - horizon.start) % _TRAJECTORY_STEP:
            return (
                f"trajectory[{index}].at {point.at.isoformat()} is not on a whole-hour offset "
                f"from horizon.start {horizon.start.isoformat()}"
            )
        previous = point.at
    if points[-1].at > horizon.end:
        return (
            f"trajectory[{len(points) - 1}].at {points[-1].at.isoformat()} "
            f"is past horizon.end {horizon.end.isoformat()}"
        )
    return None


def check_bundle_consistency(patch: SetpointsPatch) -> str | None:
    """Cross-field invariants checkable from the bundle alone (no physical model)."""
    if (
        patch.humidity_low_pct is not None
        and patch.humidity_high_pct is not None
        and patch.humidity_low_pct > patch.humidity_high_pct
    ):
        return "humidity_low_pct exceeds humidity_high_pct"
    if (
        patch.day_start is not None
        and patch.day_end is not None
        and patch.day_start >= patch.day_end
    ):
        return "day_start is not before day_end"
    for zone in patch.zones or []:
        if zone.moisture_low_threshold > zone.moisture_high_threshold:
            return f"zone {zone.zone_id} moisture_low_threshold exceeds moisture_high_threshold"
    return None


def check_crop_safe_range(patch: SetpointsPatch, bounds: StageBounds | None) -> str | None:
    """Every *bounded* patched target must sit within its crop-safe envelope (spec 06 §1).

    An absent whole-``bounds`` object or an absent per-field bound is a legal state: that target is
    simply not range-checked locally (Phase 2's write-path enforcement remains the backstop).
    """
    if bounds is None:
        return None
    for field in _BOUNDED_SCALARS:
        value = getattr(patch, field)
        bound = getattr(bounds, field)
        if value is None or bound is None:
            continue
        if not _within(float(value), bound):
            return f"{field} {value} outside crop-safe [{bound.min}, {bound.max}]"
    if patch.zones and bounds.zones is not None:
        for zone in patch.zones:
            for field in _ZONE_BOUNDED:
                value = getattr(zone, field)
                bound = getattr(bounds.zones, field)
                if bound is None:
                    continue
                if not _within(float(value), bound):
                    return (
                        f"zone {zone.zone_id} {field} {value} "
                        f"outside crop-safe [{bound.min}, {bound.max}]"
                    )
    return None


def check_constraints(
    plan: OptimizerPlan, bounds: StageBounds | None, horizon: Horizon
) -> ConstraintResult:
    """Run the deterministic constraint engine; first violation wins (all → constraint_violation)."""
    for check in (
        check_trajectory_timing(plan, horizon),
        check_immediate_matches_trajectory(plan),
        check_bundle_consistency(plan.immediate_setpoints),
        check_crop_safe_range(plan.immediate_setpoints, bounds),
    ):
        if check is not None:
            return ConstraintResult.violation(check)
    return ConstraintResult.passed()


def evaluate_application(
    plan: OptimizerPlan,
    bounds: StageBounds | None,
    confidence_threshold: float,
    horizon: Horizon,
) -> ApplicationDecision:
    """Combine the constraint engine and confidence gate into an apply / escalate / extend decision.

    - No crop-safe ``bounds`` at all ⇒ nothing to refine within, so the baseline is held and the cycle
      records a benign ``extended`` (no new application), not an escalation (spec 06 §1).
    - A constraint violation ⇒ ``escalated`` / ``constraint_violation``.
    - Confidence below the threshold ⇒ ``escalated`` / ``low_confidence``.
    - Otherwise ⇒ ``applied``.
    """
    if bounds is None:
        return ApplicationDecision(
            OutcomeStatus.EXTENDED, message="no crop-safe bounds present; holding baseline"
        )

    result = check_constraints(plan, bounds, horizon)
    if not result.ok:
        return ApplicationDecision(OutcomeStatus.ESCALATED, result.reason_code, result.message)

    if plan.confidence < confidence_threshold:
        return ApplicationDecision(
            OutcomeStatus.ESCALATED,
            ReasonCode.LOW_CONFIDENCE,
            f"confidence {plan.confidence} < threshold {confidence_threshold}",
        )

    return ApplicationDecision(OutcomeStatus.APPLIED)
