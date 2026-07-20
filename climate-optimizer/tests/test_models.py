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
