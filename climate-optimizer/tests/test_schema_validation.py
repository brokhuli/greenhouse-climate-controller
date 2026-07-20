"""The offline schema registry accepts the good fixtures and rejects the bad ones."""

from __future__ import annotations

import pytest
from jsonschema import ValidationError

from climate_optimizer import schema_validation as sv
from conftest import load_fixture


def test_planning_context_good() -> None:
    sv.validate_planning_context(
        load_fixture("platform-optimizer-planning-rest/examples/planning-context.json")
    )


def test_planning_context_bad_rejected() -> None:
    with pytest.raises(ValidationError):
        sv.validate_planning_context(
            load_fixture(
                "platform-optimizer-planning-rest/examples/planning-context.bad-range.json"
            )
        )


def test_optimizer_plan_good_and_bad() -> None:
    sv.validate_optimizer_plan(
        load_fixture("optimizer-internal-plan-schema/examples/optimizer-plan.json")
    )
    with pytest.raises(ValidationError):
        sv.validate_optimizer_plan(
            load_fixture(
                "optimizer-internal-plan-schema/examples/optimizer-plan.bad-confidence.json"
            )
        )


@pytest.mark.parametrize(
    "relpath",
    [
        "optimizer-internal-plan-schema/examples/plan-record.applied.json",
        "optimizer-internal-plan-schema/examples/plan-record.extended.json",
    ],
)
def test_plan_record_good(relpath: str) -> None:
    sv.validate_plan_record(load_fixture(relpath))


@pytest.mark.parametrize(
    "relpath",
    [
        "optimizer-internal-plan-schema/examples/plan-record.bad-applied-null-plan.json",
        "optimizer-internal-plan-schema/examples/plan-record.bad-escalated-no-reason.json",
    ],
)
def test_plan_record_bad_rejected(relpath: str) -> None:
    with pytest.raises(ValidationError):
        sv.validate_plan_record(load_fixture(relpath))


def test_sub_schema_ref_resolves() -> None:
    sv.validate_ref(
        load_fixture("platform-optimizer-planning-rest/examples/summary-series.json"),
        sv._PLANNING_BASE + "planning-context.json#/MetricSummarySeries",
    )
