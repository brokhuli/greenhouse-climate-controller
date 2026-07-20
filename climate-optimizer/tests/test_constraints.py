"""The constraint engine + application gate decide apply / escalate / extend correctly."""

from __future__ import annotations

from datetime import UTC, datetime

from climate_optimizer.constraints import check_constraints, evaluate_application
from climate_optimizer.models import (
    OptimizerPlan,
    OutcomeStatus,
    ReasonCode,
    SetpointsPatch,
    TrajectoryPoint,
)
from conftest import build_bounds

_AT = datetime(2026, 6, 17, 12, tzinfo=UTC)
BOUNDS = build_bounds()


def _plan(
    immediate: SetpointsPatch, first: SetpointsPatch | None = None, confidence: float = 0.9
) -> OptimizerPlan:
    return OptimizerPlan(
        trajectory=[TrajectoryPoint(at=_AT, setpoints=first or immediate)],
        immediate_setpoints=immediate,
        confidence=confidence,
        explanation="test",
    )


def test_in_bounds_applies() -> None:
    plan = _plan(SetpointsPatch(temperature_day_c=22.5, vpd_target_kpa=1.05))
    assert evaluate_application(plan, BOUNDS, 0.8).status is OutcomeStatus.APPLIED


def test_out_of_bounds_escalates() -> None:
    plan = _plan(SetpointsPatch(temperature_day_c=30.0))
    decision = evaluate_application(plan, BOUNDS, 0.8)
    assert decision.status is OutcomeStatus.ESCALATED
    assert decision.reason_code is ReasonCode.CONSTRAINT_VIOLATION


def test_low_confidence_escalates() -> None:
    plan = _plan(SetpointsPatch(temperature_day_c=22.5), confidence=0.5)
    decision = evaluate_application(plan, BOUNDS, 0.8)
    assert decision.reason_code is ReasonCode.LOW_CONFIDENCE


def test_immediate_must_equal_trajectory_head() -> None:
    plan = _plan(
        SetpointsPatch(temperature_day_c=22.5), first=SetpointsPatch(temperature_day_c=23.0)
    )
    assert check_constraints(plan, BOUNDS).reason_code is ReasonCode.CONSTRAINT_VIOLATION


def test_bundle_inconsistency_escalates() -> None:
    plan = _plan(SetpointsPatch(humidity_low_pct=80.0, humidity_high_pct=60.0))
    assert check_constraints(plan, BOUNDS).reason_code is ReasonCode.CONSTRAINT_VIOLATION


def test_absent_bounds_extends() -> None:
    plan = _plan(SetpointsPatch(temperature_day_c=22.5))
    assert evaluate_application(plan, None, 0.8).status is OutcomeStatus.EXTENDED


def test_unbounded_field_is_not_rejected() -> None:
    # humidity_deadband_pct has no bound in build_bounds(); Phase 2 backstops it, engine allows it.
    plan = _plan(SetpointsPatch(humidity_deadband_pct=7.0))
    assert check_constraints(plan, BOUNDS).ok
