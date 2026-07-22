"""The Service API surface (spec 10 §Service API endpoints).

Reads stay available in every state — including while the optimizer is paused — so an operator can
always inspect the last plans and the standing escalations. Only the four mutating endpoints are
operator-gated, and each is structured-logged with the operator identity and supplied reason.

``/health`` and ``/metrics`` sit outside ``/api`` and outside the versioned contracts: they are the
optimizer's own unversioned operational surface, the Go API deriving the frontend's
``GET /api/optimizer/status`` from the former and Prometheus scraping the latter.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response, status
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from ..models import BackendRole, PlanRecord
from ..runtime import ModelNotAllowedError
from ..scheduler import CycleInFlightError, OptimizerDisabledError
from ..store import Escalation
from .context import build_health
from .deps import Context, Operator
from .schemas import (
    CycleRequest,
    EnableRequest,
    EnableStateResponse,
    EscalationResponse,
    FleetGreenhouse,
    FleetResponse,
    FleetRollupResponse,
    GreenhouseEnableStateResponse,
    HealthResponse,
    ModelSelectionRequest,
    ModelStateResponse,
    ResolveRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter()
api = APIRouter(prefix="/api/optimizer")


def _escalation_response(escalation: Escalation) -> EscalationResponse:
    return EscalationResponse(
        escalation_id=escalation.escalation_id,
        greenhouse_id=escalation.greenhouse_id,
        reason_code=escalation.reason_code,
        reason_class=escalation.reason_class,
        optimizer_run_id=escalation.optimizer_run_id,
        opened_at=escalation.opened_at,
        last_seen_at=escalation.last_seen_at,
        recurrence_count=escalation.recurrence_count,
        message=escalation.message,
        resolution=escalation.resolution,
        resolved_at=escalation.resolved_at,
    )


@router.get("/health", response_model=HealthResponse)
async def health(ctx: Context) -> HealthResponse:
    """Liveness/readiness for a supervisor and the operator badge (spec 09)."""
    return await build_health(ctx)


@router.get("/metrics")
async def prometheus_metrics() -> Response:
    """Prometheus optimizer-health scrape — unauthenticated, outside the versioned contracts."""
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@api.get("/fleet", response_model=FleetResponse)
async def fleet(ctx: Context) -> FleetResponse:
    """Per-greenhouse latest outcome + enable flag, plus the site rollup — one read, not N."""
    now = datetime.now(UTC)
    latest = ctx.store.plans.all_latest()
    rollup = ctx.store.rollup(now)

    greenhouses = [
        FleetGreenhouse(
            greenhouse_id=greenhouse_id,
            enabled=ctx.runtime.greenhouse_enabled(greenhouse_id).enabled,
            status=record.outcome.status,
            reason_code=record.outcome.reason_code,
            created_at=record.created_at,
            optimizer_run_id=record.optimizer_run_id,
        )
        for greenhouse_id, record in sorted(latest.items())
    ]
    return FleetResponse(
        greenhouses=greenhouses,
        rollup=FleetRollupResponse(
            backlog=rollup.backlog,
            applied=rollup.applied,
            escalated=rollup.escalated,
            extended=rollup.extended,
            oldest_open_escalation_age_seconds=rollup.oldest_open_escalation_age_seconds,
        ),
    )


@api.get("/greenhouses/{greenhouse_id}/plans/latest", response_model=PlanRecord)
async def latest_plan(greenhouse_id: str, ctx: Context) -> PlanRecord:
    """Inspect the latest proposed / applied plan for one greenhouse."""
    record = ctx.store.plans.latest(greenhouse_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"no plan recorded for {greenhouse_id}")
    return record


@api.post(
    "/greenhouses/{greenhouse_id}/cycles",
    response_model=PlanRecord,
    status_code=status.HTTP_202_ACCEPTED,
)
async def trigger_cycle(
    greenhouse_id: str, body: CycleRequest, ctx: Context, operator: Operator
) -> PlanRecord:
    """Run an on-demand cycle. Refused with 409 while paused or already planning (spec 02)."""
    logger.info(
        "operator triggered a cycle",
        extra={
            "event": "optimizer_cycle_requested",
            "greenhouse_id": greenhouse_id,
            "actor": operator.label,
            "reason": body.reason,
        },
    )
    try:
        return await ctx.scheduler.trigger(greenhouse_id, reason=body.reason)
    except (OptimizerDisabledError, CycleInFlightError) as err:
        raise HTTPException(status_code=409, detail=str(err)) from err


@api.get("/escalations", response_model=list[EscalationResponse])
async def list_escalations(ctx: Context) -> list[EscalationResponse]:
    """The open set, triage-ordered (persistent before transient, then oldest first)."""
    return [_escalation_response(item) for item in ctx.store.escalations.open_escalations()]


@api.post("/escalations/{escalation_id}/resolve", response_model=EscalationResponse)
async def resolve_escalation(
    escalation_id: UUID, body: ResolveRequest, ctx: Context, operator: Operator
) -> EscalationResponse:
    """Close an open escalation as the ``operator`` resolution."""
    resolved = ctx.store.escalations.resolve(
        escalation_id, now=datetime.now(UTC), actor=operator.label
    )
    if resolved is None:
        raise HTTPException(status_code=404, detail="no open escalation with that id")
    logger.info(
        "operator resolved an escalation",
        extra={
            "event": "optimizer_escalation_resolved",
            "escalation_id": str(escalation_id),
            "greenhouse_id": resolved.greenhouse_id,
            "actor": operator.label,
            "reason": body.reason,
        },
    )
    return _escalation_response(resolved)


@api.get("/model", response_model=ModelStateResponse)
async def get_model(ctx: Context) -> ModelStateResponse:
    """The active backend and the active provider's runtime allowlist."""
    return ModelStateResponse(
        provider=ctx.runtime.provider,
        model=ctx.runtime.model,
        prompt_version=ctx.settings.llm.prompt_version,
        role=BackendRole.PRIMARY,
        available_models=ctx.runtime.available_models,
    )


@api.post("/model", response_model=ModelStateResponse)
async def set_model(
    body: ModelSelectionRequest, ctx: Context, operator: Operator
) -> ModelStateResponse:
    """Switch the active model within the allowlist; takes effect on the next cycle (spec 10)."""
    try:
        ctx.runtime.set_model(body.model, reason=body.reason, actor=operator.label)
    except ModelNotAllowedError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    return await get_model(ctx)


@api.get("/enabled", response_model=EnableStateResponse)
async def get_enabled(ctx: Context) -> EnableStateResponse:
    """Whether planning is enabled, or the service is in read-only mode."""
    state = ctx.runtime.enabled
    return EnableStateResponse(
        enabled=state.enabled, reason=state.reason, changed_at=state.changed_at
    )


@api.post("/enabled", response_model=EnableStateResponse)
async def set_enabled(body: EnableRequest, ctx: Context, operator: Operator) -> EnableStateResponse:
    """Pause or resume the whole optimizer; immediate, in-memory, resets on restart (spec 09)."""
    state = ctx.runtime.set_enabled(body.enabled, reason=body.reason, actor=operator.label)
    return EnableStateResponse(
        enabled=state.enabled, reason=state.reason, changed_at=state.changed_at
    )


@api.get("/greenhouses/{greenhouse_id}/enabled", response_model=GreenhouseEnableStateResponse)
async def get_greenhouse_enabled(greenhouse_id: str, ctx: Context) -> GreenhouseEnableStateResponse:
    """Whether planning is enabled for one greenhouse (default on)."""
    state = ctx.runtime.greenhouse_enabled(greenhouse_id)
    return GreenhouseEnableStateResponse(
        greenhouse_id=greenhouse_id,
        enabled=state.enabled,
        reason=state.reason,
        changed_at=state.changed_at,
    )


@api.post("/greenhouses/{greenhouse_id}/enabled", response_model=GreenhouseEnableStateResponse)
async def set_greenhouse_enabled(
    greenhouse_id: str, body: EnableRequest, ctx: Context, operator: Operator
) -> GreenhouseEnableStateResponse:
    """Pause or resume one greenhouse; the global pause still takes precedence (spec 09)."""
    state = ctx.runtime.set_greenhouse_enabled(
        greenhouse_id, body.enabled, reason=body.reason, actor=operator.label
    )
    return GreenhouseEnableStateResponse(
        greenhouse_id=greenhouse_id,
        enabled=state.enabled,
        reason=state.reason,
        changed_at=state.changed_at,
    )


router.include_router(api)
