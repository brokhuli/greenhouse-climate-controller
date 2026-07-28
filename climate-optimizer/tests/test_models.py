"""Domain models round-trip the contract fixtures and enforce the conditional invariants."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from climate_optimizer.models import (
    Backend,
    BackendRole,
    Horizon,
    OptimizerPlan,
    Outcome,
    OutcomeStatus,
    PlanningContext,
    PlanRecord,
    Provider,
    ReasonCode,
    SetpointAdjustments,
    SetpointDecision,
    SetpointsPatch,
)
from conftest import load_fixture

_PLAN_RECORD_GOOD = [
    "optimizer-internal-plan-schema/examples/plan-record.applied.json",
    "optimizer-internal-plan-schema/examples/plan-record.escalated-input-stale.json",
    "optimizer-internal-plan-schema/examples/plan-record.escalated-low-confidence.json",
    "optimizer-internal-plan-schema/examples/plan-record.extended.json",
]


def test_planning_context_fixture_parses() -> None:
    ctx = PlanningContext.model_validate(
        load_fixture("platform-optimizer-planning-rest/examples/planning-context.json")
    )
    assert ctx.greenhouse_id == "gh-a"
    assert ctx.from_ < ctx.to


def test_optimizer_plan_fixture_parses() -> None:
    plan = OptimizerPlan.model_validate(
        load_fixture("optimizer-internal-plan-schema/examples/optimizer-plan.json")
    )
    assert 0.0 <= plan.confidence <= 1.0
    assert plan.trajectory


@pytest.mark.parametrize("relpath", _PLAN_RECORD_GOOD)
def test_plan_record_good_fixtures_parse(relpath: str) -> None:
    record = PlanRecord.model_validate(load_fixture(relpath))
    if record.outcome.status is OutcomeStatus.APPLIED:
        assert record.plan is not None


def _record_kwargs() -> dict[str, object]:
    return {
        "schema_version": 1,
        "optimizer_run_id": "018f9c2e-6b7a-7c31-9e4d-2a1b5c6d7e8f",
        "greenhouse_id": "gh-a",
        "created_at": "2026-07-11T13:30:00.000Z",
        "horizon": Horizon(start="2026-07-11T13:30:00Z", end="2026-07-12T01:30:00Z"),
        "backend": Backend(
            provider=Provider.OLLAMA, model="llama3", prompt_version="v1", role=BackendRole.PRIMARY
        ),
    }


def test_held_outcome_requires_reason_code() -> None:
    with pytest.raises(ValidationError):
        Outcome(status=OutcomeStatus.HELD)


def test_applied_record_requires_plan() -> None:
    with pytest.raises(ValidationError):
        PlanRecord(plan=None, outcome=Outcome(status=OutcomeStatus.APPLIED), **_record_kwargs())


def test_failed_outcome_requires_reason() -> None:
    with pytest.raises(ValidationError):
        Outcome(status=OutcomeStatus.FAILED, message="failed")


def test_reason_code_present_is_accepted() -> None:
    outcome = Outcome(status=OutcomeStatus.HELD, reason_code=ReasonCode.LOW_CONFIDENCE)
    assert outcome.reason_code is ReasonCode.LOW_CONFIDENCE


def test_empty_setpoints_patch_rejected() -> None:
    with pytest.raises(ValidationError):
        SetpointsPatch()


def test_unknown_field_rejected() -> None:
    with pytest.raises(ValidationError):
        SetpointsPatch.model_validate({"nope": 1})


def test_explicit_null_field_rejected() -> None:
    # An explicit null is not "unchanged" — it would survive exclude_unset onto the wire and
    # violate the setpoint API's non-null field types, so it must be rejected up front.
    with pytest.raises(ValidationError):
        SetpointsPatch(temperature_day_c=None)
    with pytest.raises(ValidationError):
        SetpointsPatch.model_validate({"temperature_day_c": 22.5, "vpd_target_kpa": None})


def test_partial_patch_still_valid() -> None:
    patch = SetpointsPatch(temperature_day_c=22.5)
    assert patch.model_dump(exclude_unset=True) == {"temperature_day_c": 22.5}


# -- the delta / grounded LLM shapes (SetpointAdjustments / SetpointDecision) ----


def test_setpoint_adjustments_allow_empty() -> None:
    # An empty adjustments object is the model's "hold"; the planner reads it as a no-change extend.
    assert SetpointAdjustments().model_dump(exclude_none=True) == {}


def test_setpoint_adjustments_tolerate_explicit_null() -> None:
    # A backend may emit null for a target it is not moving; the model drops it (exclude_none).
    adj = SetpointAdjustments.model_validate({"temperature_day_c": -1.0, "vpd_target_kpa": None})
    assert adj.model_dump(exclude_none=True) == {"temperature_day_c": -1.0}


def test_setpoint_adjustments_cap_the_delta_and_reject_unknown_fields() -> None:
    # The caps are what make an absolute unrepresentable: 23 is far outside the +/-3 temperature delta,
    # so a constrained-decoding backend cannot emit it — it can only nudge from the current value.
    with pytest.raises(ValidationError):
        SetpointAdjustments(temperature_day_c=23.0)
    with pytest.raises(ValidationError):
        SetpointAdjustments.model_validate({"nope": 1})


def test_setpoint_decision_accepts_empty_adjustments() -> None:
    decision = SetpointDecision(
        situation="s", reasoning="r", adjustments=SetpointAdjustments(), confidence=0.5
    )
    assert decision.adjustments.model_dump(exclude_none=True) == {}


def test_setpoint_decision_enforces_confidence() -> None:
    with pytest.raises(ValidationError):
        SetpointDecision(
            situation="s", reasoning="r", adjustments=SetpointAdjustments(), confidence=1.5
        )


def _plan_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "trajectory": [
            {
                "at": "2026-07-11T13:30:00Z",
                "setpoints": {"temperature_day_c": 22.5, "co2_target_ppm": 900},
            },
            {"at": "2026-07-11T14:30:00Z", "setpoints": {"co2_target_ppm": 950}},
        ],
        "immediate_setpoints": {"temperature_day_c": 22.5, "co2_target_ppm": 900},
        "confidence": 0.9,
        "explanation": "test",
    }
    payload.update(overrides)
    return payload


def test_immediate_setpoints_backfilled_when_omitted() -> None:
    # A small model routinely omits this redundant field; the plan is backfilled from trajectory[0]
    # rather than rejected (immediate_setpoints ≡ trajectory[0].setpoints, spec 06 §1).
    payload = _plan_payload()
    del payload["immediate_setpoints"]
    plan = OptimizerPlan.model_validate(payload)
    assert plan.immediate_setpoints == plan.trajectory[0].setpoints


def test_immediate_setpoints_backfilled_when_explicitly_null() -> None:
    plan = OptimizerPlan.model_validate(_plan_payload(immediate_setpoints=None))
    assert plan.immediate_setpoints == plan.trajectory[0].setpoints


def test_immediate_setpoints_left_untouched_when_present() -> None:
    plan = OptimizerPlan.model_validate(_plan_payload(immediate_setpoints={"vpd_target_kpa": 0.8}))
    assert plan.immediate_setpoints.model_dump(exclude_unset=True) == {"vpd_target_kpa": 0.8}
    assert plan.immediate_setpoints != plan.trajectory[0].setpoints
