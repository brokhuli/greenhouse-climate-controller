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
    SetpointDecision,
    SetpointsDraft,
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


def test_escalated_outcome_requires_reason_code() -> None:
    with pytest.raises(ValidationError):
        Outcome(status=OutcomeStatus.ESCALATED)


def test_applied_record_requires_plan() -> None:
    with pytest.raises(ValidationError):
        PlanRecord(plan=None, outcome=Outcome(status=OutcomeStatus.APPLIED), **_record_kwargs())


def test_escalated_record_requires_reason() -> None:
    with pytest.raises(ValidationError):
        Outcome(status=OutcomeStatus.ESCALATED, message="held")


def test_reason_code_present_is_accepted() -> None:
    outcome = Outcome(status=OutcomeStatus.ESCALATED, reason_code=ReasonCode.LOW_CONFIDENCE)
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


# -- the lenient LLM-ingestion shapes (SetpointsDraft / SetpointDecision) ----


def test_setpoints_draft_allows_empty() -> None:
    # The lenient twin tolerates the empty "hold" object the strict patch rejects (constrained
    # decoding can return `{}`); the planner reads it as a no-change decision.
    assert SetpointsDraft().model_dump(exclude_none=True) == {}


def test_setpoints_draft_tolerates_explicit_null() -> None:
    # A backend may emit null for a field it is not changing; the draft accepts it and the planner
    # drops it (exclude_none) rather than raising the strict patch's no-null error.
    draft = SetpointsDraft.model_validate({"temperature_day_c": 22.5, "vpd_target_kpa": None})
    assert draft.model_dump(exclude_none=True) == {"temperature_day_c": 22.5}


def test_setpoints_draft_still_enforces_ranges_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        SetpointsDraft(temperature_day_c=999.0)
    with pytest.raises(ValidationError):
        SetpointsDraft.model_validate({"nope": 1})


def test_setpoint_decision_accepts_an_empty_bundle() -> None:
    decision = SetpointDecision(setpoints=SetpointsDraft(), confidence=0.5, explanation="hold")
    assert decision.setpoints.model_dump(exclude_none=True) == {}


def test_setpoint_decision_enforces_confidence_and_explanation() -> None:
    with pytest.raises(ValidationError):
        SetpointDecision(setpoints=SetpointsDraft(), confidence=1.5, explanation="x")
    with pytest.raises(ValidationError):
        SetpointDecision(setpoints=SetpointsDraft(), confidence=0.5, explanation="")


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
