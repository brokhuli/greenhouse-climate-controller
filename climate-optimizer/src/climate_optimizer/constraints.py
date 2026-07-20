"""Constraint engine + application gate (spec 06) — the deterministic guardrails on plan output.

The engine validates the setpoints the optimizer would write against the two checks it can make
deterministically from data in hand — the crop-safe bounds delivered in the planning context and the
bundle's own self-consistency — plus the structural precondition that ``immediate_setpoints`` equals
``trajectory[0].setpoints`` field-for-field. The application gate then combines the engine verdict with
the confidence threshold to decide apply / escalate / extend. It never checks actuator ranges,
interlocks, or reachability: those are controller-owned (spec 06 §1).
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import Bound, OptimizerPlan, OutcomeStatus, ReasonCode, SetpointsPatch, StageBounds

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


def _within(value: float, bound: Bound) -> bool:
    return bound.min <= value <= bound.max


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


def check_constraints(plan: OptimizerPlan, bounds: StageBounds | None) -> ConstraintResult:
    """Run the deterministic constraint engine; first violation wins (all → constraint_violation)."""
    for check in (
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

    result = check_constraints(plan, bounds)
    if not result.ok:
        return ApplicationDecision(OutcomeStatus.ESCALATED, result.reason_code, result.message)

    if plan.confidence < confidence_threshold:
        return ApplicationDecision(
            OutcomeStatus.ESCALATED,
            ReasonCode.LOW_CONFIDENCE,
            f"confidence {plan.confidence} < threshold {confidence_threshold}",
        )

    return ApplicationDecision(OutcomeStatus.APPLIED)
