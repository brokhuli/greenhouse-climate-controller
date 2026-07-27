"""The two-layer plan contract: ``OptimizerPlan`` (LLM output) and ``PlanRecord`` (envelope).

Mirrors ``contracts/optimizer-internal-plan-schema/`` (optimizer-plan / plan-record). The
conditional invariants the JSON Schema enforces are re-expressed as validators here:
``reason_code`` is required iff ``status == escalated``, and an ``applied`` record carries a
non-null ``plan``. The ``immediate_setpoints ≡ trajectory[0].setpoints`` invariant is *not*
here — it is a constraint-engine check (spec 06 §1), matching the contract note.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import Field, model_validator

from .base import SLUG_PATTERN, StrictModel
from .enums import BackendRole, OutcomeStatus, Provider, ReasonCode
from .setpoints import SetpointsPatch


class TrajectoryPoint(StrictModel):
    """One hour of the refined setpoint trajectory across the horizon."""

    at: datetime
    setpoints: SetpointsPatch


class ObjectiveScores(StrictModel):
    """Advisory / explainability weighting of how each objective shaped the plan."""

    anticipation: float = Field(ge=0, le=1)
    coupling: float = Field(ge=0, le=1)
    efficiency: float = Field(ge=0, le=1)


class EscalationHint(StrictModel):
    """Optional planner self-flag — advisory only; the authoritative reason_code is downstream."""

    reason_code: str | None = None
    note: str | None = None

    @model_validator(mode="after")
    def _at_least_one_field(self) -> EscalationHint:
        if not self.model_fields_set:
            raise ValueError("EscalationHint must set at least one field")
        return self


class OptimizerPlan(StrictModel):
    """The LLM planner's structured output — proposed, not authoritative until the gates clear it."""

    trajectory: list[TrajectoryPoint] = Field(min_length=1)
    immediate_setpoints: SetpointsPatch
    confidence: float = Field(ge=0, le=1)
    explanation: str = Field(min_length=1)
    objective_scores: ObjectiveScores | None = None
    escalation_hint: EscalationHint | None = None

    @model_validator(mode="before")
    @classmethod
    def _default_immediate_from_trajectory(cls, data: Any) -> Any:
        # ``immediate_setpoints`` stays required — the wire contract (optimizer-plan.schema.json) and
        # every consumer keep the non-null type. This is a pure LLM-output ingestion tolerance: a small
        # model routinely omits (or nulls) this field, which never carries new information because
        # ``immediate_setpoints ≡ trajectory[0].setpoints`` (the constraint engine re-checks the
        # equality, spec 06 §1). Backfilling from the first trajectory point *before* field validation
        # turns that near-miss into a contract-valid plan instead of a hold. A raw JSON dict has
        # dict trajectory points; a Python-constructed plan has TrajectoryPoint objects — handle both.
        if not isinstance(data, dict) or data.get("immediate_setpoints") is not None:
            return data
        trajectory = data.get("trajectory")
        if not trajectory:
            return data  # let field validation raise the real "trajectory" error
        first = trajectory[0]
        setpoints = (
            first.get("setpoints") if isinstance(first, dict) else getattr(first, "setpoints", None)
        )
        if setpoints is None:
            return data
        return {**data, "immediate_setpoints": setpoints}


class Backend(StrictModel):
    """Which model and prompt produced the plan (provenance)."""

    provider: Provider
    model: str = Field(min_length=1)
    prompt_version: str = Field(min_length=1)
    role: BackendRole


class Horizon(StrictModel):
    """The adaptive window the service chose for the cycle; ``trajectory`` spans [start, end]."""

    start: datetime
    end: datetime


class Outcome(StrictModel):
    """What the gates decided. ``reason_code`` is required when ``status == escalated``."""

    status: OutcomeStatus
    reason_code: ReasonCode | None = None
    message: str | None = None

    @model_validator(mode="after")
    def _reason_required_when_escalated(self) -> Outcome:
        if self.status == OutcomeStatus.ESCALATED and self.reason_code is None:
            raise ValueError("reason_code is required when status is escalated")
        return self


class PlanRecord(StrictModel):
    """The optimizer service's envelope around one ``OptimizerPlan`` for one cycle."""

    schema_version: int = Field(ge=1)
    optimizer_run_id: UUID
    greenhouse_id: str = Field(pattern=SLUG_PATTERN)
    created_at: datetime
    horizon: Horizon
    backend: Backend
    plan: OptimizerPlan | None
    source_plan_id: UUID | None = None
    outcome: Outcome

    @model_validator(mode="after")
    def _applied_requires_plan(self) -> PlanRecord:
        if self.outcome.status == OutcomeStatus.APPLIED and self.plan is None:
            raise ValueError("an applied PlanRecord must carry a non-null plan")
        return self
