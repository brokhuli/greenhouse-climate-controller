"""The planning cycle (specs 02, 05, 06, 09) — one greenhouse, one pass through the pipeline.

    read history → validate input quality → simulate forward → plan → validate → apply

Every branch of that pipeline ends the same way: a :class:`~climate_optimizer.models.PlanRecord` is
emitted **whatever happened**, so the operator surface always shows the cycle ran (spec 05 §3). The
three outcomes are:

* ``applied`` — the plan cleared the constraint engine and the confidence gate, and Phase 2 accepted
  the immediate bundle.
* ``escalated`` — surfaced, not applied. Carries a canonical reason code; a *post-planner* escalation
  keeps the plan it rejected, a *pre-planner* hold has ``plan: null``.
* ``extended`` — nothing new was planned and **nothing was written**: the state-change gate skipped
  the LLM, or there were no crop-safe bounds to refine within. The last applied bundle stays in force
  because Phase 2 already holds it — to *extend* is to hold, never to replay the trajectory forward.

The universal invariant across all three (P3-RESIL-1): a held cycle **writes nothing**, so the
greenhouse keeps running on the last accepted setpoints or the crop-profile baseline. A cycle of
refinement is lost, never control.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from . import metrics, schema_validation
from .config import Settings
from .constraints import evaluate_application
from .dataaccess import PlatformClient, PlatformError
from .gating import evaluate_input_gate
from .models import (
    Backend,
    BackendRole,
    Horizon,
    Metric,
    OptimizerPlan,
    Outcome,
    OutcomeStatus,
    PlanningContext,
    PlanRecord,
    ReasonCode,
)
from .params import TwinParams
from .planner import (
    ContextBudgetExceededError,
    Planner,
    PlannerUnavailableError,
    choose_horizon,
    evaluate_state_change,
)
from .runtime import RuntimeState
from .store import GreenhouseState, ServiceStore
from .twin import fidelity_residual, seed_state_from_context, simulate

logger = logging.getLogger(__name__)

# Major version of the internal plan contract (bumping it is an ADR event).
PLAN_RECORD_SCHEMA_VERSION = 1

# Metrics the twin's one-step-ahead fidelity residual is measured over (derived VPD/DLI excluded).
_FIDELITY_METRICS = (Metric.TEMPERATURE, Metric.HUMIDITY, Metric.CO2, Metric.PAR)


class _Held(Exception):
    """Internal control flow: a pipeline step decided to hold the cycle."""

    def __init__(
        self,
        status: OutcomeStatus,
        reason_code: ReasonCode | None,
        message: str,
        *,
        plan: OptimizerPlan | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.reason_code = reason_code
        self.message = message
        self.plan = plan


def plan_record_payload(record: PlanRecord) -> dict[str, Any]:
    """Serialize a ``PlanRecord`` to its wire shape for contract validation.

    Optional contract fields must be **absent** rather than null (``additionalProperties: false``
    with typed properties), while ``plan`` is required *and* nullable — so drop every ``None`` and
    then put ``plan`` back when the cycle produced no plan.
    """
    payload = record.model_dump(mode="json", exclude_none=True)
    if record.plan is None:
        payload["plan"] = None
    return payload


@dataclass
class _CycleFrame:
    """Everything a record needs, fixed up front so even a timeout can emit one."""

    greenhouse_id: str
    run_id: UUID
    now: datetime
    backend: Backend
    horizon: Horizon
    source_plan_id: UUID | None


def _latest_observations(ctx: PlanningContext) -> dict[Metric, float]:
    """Latest non-empty bucket mean per fidelity metric — what the twin's prediction is scored on."""
    observed: dict[Metric, float] = {}
    for series in ctx.telemetry:
        if series.metric not in _FIDELITY_METRICS or series.zone_id is not None:
            continue
        buckets = [bucket for bucket in series.buckets if bucket.count > 0]
        if buckets:
            observed[series.metric] = max(buckets, key=lambda b: b.bucket_start).mean
    return observed


async def run_cycle(
    greenhouse_id: str,
    *,
    settings: Settings,
    client: PlatformClient,
    planner: Planner,
    runtime: RuntimeState,
    store: ServiceStore,
    params: TwinParams,
    now: datetime | None = None,
    on_demand: bool = False,
) -> PlanRecord:
    """Run one planning cycle, bounded by ``service.cycle_timeout_seconds``.

    The cadence is a **ceiling, not a best-effort target** (spec 09): a cycle that overruns is timed
    out, the last applied bundle stays in force, and the loop self-heals on the next tick rather than
    wedging.
    """
    started = time.monotonic()
    moment = now or datetime.now(UTC)
    state = store.fleet.get(greenhouse_id)
    frame = _CycleFrame(
        greenhouse_id=greenhouse_id,
        run_id=uuid4(),
        now=moment,
        backend=Backend(
            provider=runtime.provider,
            model=runtime.model,
            prompt_version=settings.llm.prompt_version,
            role=BackendRole.PRIMARY,
        ),
        horizon=Horizon(
            start=moment, end=moment + timedelta(hours=settings.planning.horizon_hours)
        ),
        source_plan_id=state.last_applied_plan_id,
    )

    try:
        record = await asyncio.wait_for(
            _run_pipeline(
                frame,
                settings=settings,
                client=client,
                planner=planner,
                runtime=runtime,
                store=store,
                params=params,
                on_demand=on_demand,
            ),
            timeout=settings.service.cycle_timeout_seconds,
        )
    except TimeoutError:
        record = _build_record(
            frame,
            plan=None,
            status=OutcomeStatus.ESCALATED,
            reason_code=ReasonCode.CYCLE_TIMEOUT,
            message=(
                f"cycle exceeded cycle_timeout_seconds "
                f"({settings.service.cycle_timeout_seconds:g}s)"
            ),
        )
    except _Held as held:
        record = _build_record(
            frame,
            plan=held.plan,
            status=held.status,
            reason_code=held.reason_code,
            message=held.message,
        )

    _settle(record, store=store, settings=settings, now=frame.now)
    metrics.CYCLE_DURATION_SECONDS.labels(greenhouse_id).observe(time.monotonic() - started)
    metrics.CYCLES_TOTAL.labels(greenhouse_id, record.outcome.status.value).inc()
    logger.info(
        "planning cycle complete",
        extra={
            "event": "optimizer_cycle_complete",
            "optimizer_run_id": str(record.optimizer_run_id),
            "greenhouse_id": greenhouse_id,
            "status": record.outcome.status.value,
            "reason_code": (
                record.outcome.reason_code.value if record.outcome.reason_code else None
            ),
            "on_demand": on_demand,
            "model": record.backend.model,
            "prompt_version": record.backend.prompt_version,
        },
    )
    return record


async def _run_pipeline(
    frame: _CycleFrame,
    *,
    settings: Settings,
    client: PlatformClient,
    planner: Planner,
    runtime: RuntimeState,
    store: ServiceStore,
    params: TwinParams,
    on_demand: bool,
) -> PlanRecord:
    """The pipeline proper; every hold raises :class:`_Held` for the caller to record."""
    state = store.fleet.get(frame.greenhouse_id)

    # 1. Read — the only inbound channel, a Phase-2 REST contract (RFC-008).
    try:
        ctx = await client.get_planning_context(frame.greenhouse_id)
    except PlatformError as err:
        raise _Held(OutcomeStatus.ESCALATED, err.reason_code, err.message) from err

    # 2. Input-quality gate — never plan over stale, incomplete, or faulted inputs (spec 07).
    gate = evaluate_input_gate(ctx, settings, expected_greenhouse_id=frame.greenhouse_id)
    if not gate.trusted:
        assert gate.reason_code is not None  # noqa: S101 — GateOutcome.hold always sets one
        raise _Held(OutcomeStatus.ESCALATED, gate.reason_code, gate.message or "input gate held")

    frame.horizon = choose_horizon(ctx.to, ctx.setpoints.targets, settings)

    # 3. Twin fidelity — score the *previous* cycle's prediction against what actually happened.
    fidelity_fault = _update_fidelity(frame, ctx, state, settings=settings, params=params)

    # 4. Simulate the baseline forward: the current Phase-2 setpoints under the twin (spec 02).
    seed = seed_state_from_context(ctx, params)
    result = simulate(
        seed,
        ctx.setpoints.targets,
        end=frame.horizon.end,
        params=params,
        max_step_minutes=settings.twin.solver_max_step_minutes,
        output_interval_minutes=settings.twin.output_interval_minutes,
    )
    state.last_forecast = result.points
    if result.diverged:
        metrics.TWIN_DIVERGENCE_TOTAL.labels(frame.greenhouse_id, "diverged").inc()
        raise _Held(
            OutcomeStatus.ESCALATED,
            ReasonCode.TWIN_DIVERGED,
            "twin diverged (non-finite or out-of-envelope step)",
        )

    # 5. Nothing to refine within — a benign pre-planner extend, not an escalation (spec 06 §1).
    if ctx.setpoints.bounds is None:
        raise _Held(
            OutcomeStatus.EXTENDED,
            None,
            "no crop-safe bounds present; holding the baseline",
        )

    # 6. State-change gate — an on-demand cycle deliberately bypasses only this (spec 04).
    if not on_demand:
        decision = evaluate_state_change(
            result.points,
            state.reference_forecast,
            threshold=settings.planning.state_change_threshold,
            params=params,
        )
        if decision.suppressed:
            metrics.PLANNER_SUPPRESSED_TOTAL.labels(frame.greenhouse_id).inc()
            raise _Held(OutcomeStatus.EXTENDED, None, decision.reason)

    # 7. Plan.
    try:
        proposal = await planner.propose(
            ctx,
            baseline_forecast=result.points,
            horizon=frame.horizon,
            model=runtime.model,
            now=frame.now,
        )
    except (PlannerUnavailableError, ContextBudgetExceededError) as err:
        raise _Held(OutcomeStatus.ESCALATED, ReasonCode.LLM_UNAVAILABLE, str(err)) from err

    plan = proposal.output.plan
    frame.backend = Backend(
        provider=proposal.output.provider,
        model=proposal.output.model,
        prompt_version=settings.llm.prompt_version,
        role=proposal.output.role,
    )
    if proposal.output.role is BackendRole.FALLBACK:
        metrics.PLANNER_FAILOVER_TOTAL.labels(frame.greenhouse_id).inc()

    try:
        schema_validation.validate_optimizer_plan(plan.model_dump(mode="json", exclude_none=True))
    except Exception as err:  # noqa: BLE001 — a plan off-contract is a plan we cannot use
        raise _Held(
            OutcomeStatus.ESCALATED,
            ReasonCode.LLM_UNAVAILABLE,
            f"plan failed contract validation: {err}",
        ) from err

    # 8. Validate — the deterministic guardrails, and the confidence gate (spec 06).
    decision_gate = evaluate_application(
        plan, ctx.setpoints.bounds, settings.application.confidence_threshold
    )
    if decision_gate.status is not OutcomeStatus.APPLIED:
        raise _Held(
            decision_gate.status,
            decision_gate.reason_code,
            decision_gate.message or "application gate held the cycle",
            plan=plan,
        )

    # Sustained twin drift caps confidence below the threshold, so a fidelity fault can never
    # auto-apply — it is surfaced with its own code, carrying the plan it withheld (spec 03 §2).
    if fidelity_fault:
        raise _Held(
            OutcomeStatus.ESCALATED,
            ReasonCode.TWIN_FIDELITY_FAULT,
            "sustained twin parameter drift; confidence capped below the apply threshold",
            plan=plan,
        )

    # 9. Apply — only the immediate next bundle, layered on the crop baseline (spec 06 §2).
    write = await client.submit_setpoints(frame.greenhouse_id, plan.immediate_setpoints)
    if not write.applied:
        raise _Held(OutcomeStatus.ESCALATED, write.reason_code, write.message, plan=plan)

    state.last_applied_plan_id = frame.run_id
    state.last_applied_setpoints = plan.immediate_setpoints
    state.retained_trajectory = list(plan.trajectory)
    state.reference_forecast = result.points
    store.last_successful_cycle_at = frame.now
    metrics.LAST_SUCCESSFUL_CYCLE_TIMESTAMP.set(frame.now.timestamp())

    return _build_record(
        frame,
        plan=plan,
        status=OutcomeStatus.APPLIED,
        reason_code=None,
        message=write.message,
    )


def _update_fidelity(
    frame: _CycleFrame,
    ctx: PlanningContext,
    state: GreenhouseState,
    *,
    settings: Settings,
    params: TwinParams,
) -> bool:
    """Score the retained forecast against observation; return whether drift is now sustained.

    A breach only counts when it is **consecutive**: a single off prediction is noise, while
    ``fidelity_breach_cycles`` in a row is parameter drift the twin cannot self-correct (spec 03 §2).
    """
    if not state.last_forecast:
        return False

    residual = fidelity_residual(state.last_forecast, _latest_observations(ctx), ctx.to, params)
    if residual is None:
        return False

    if residual > settings.twin.divergence_threshold:
        state.consecutive_fidelity_breaches += 1
    else:
        state.consecutive_fidelity_breaches = 0

    if state.consecutive_fidelity_breaches < settings.twin.fidelity_breach_cycles:
        return False

    metrics.TWIN_DIVERGENCE_TOTAL.labels(frame.greenhouse_id, "fidelity_fault").inc()
    logger.warning(
        "twin fidelity fault",
        extra={
            "event": "optimizer_twin_fidelity_fault",
            "optimizer_run_id": str(frame.run_id),
            "greenhouse_id": frame.greenhouse_id,
            "residual": residual,
            "consecutive_breaches": state.consecutive_fidelity_breaches,
        },
    )
    return True


def _build_record(
    frame: _CycleFrame,
    *,
    plan: OptimizerPlan | None,
    status: OutcomeStatus,
    reason_code: ReasonCode | None,
    message: str | None,
) -> PlanRecord:
    """Assemble the cycle's record; ``source_plan_id`` names the bundle left in force on a hold."""
    return PlanRecord(
        schema_version=PLAN_RECORD_SCHEMA_VERSION,
        optimizer_run_id=frame.run_id,
        greenhouse_id=frame.greenhouse_id,
        created_at=frame.now,
        horizon=frame.horizon,
        backend=frame.backend,
        plan=plan,
        source_plan_id=None if status is OutcomeStatus.APPLIED else frame.source_plan_id,
        outcome=Outcome(status=status, reason_code=reason_code, message=message),
    )


def _settle(record: PlanRecord, *, store: ServiceStore, settings: Settings, now: datetime) -> None:
    """Persist the record and move the escalation lifecycle along (spec 09)."""
    store.plans.record(record)

    service = settings.service
    reason_code = record.outcome.reason_code
    if record.outcome.status is OutcomeStatus.ESCALATED and reason_code is not None:
        store.escalations.raise_escalation(
            greenhouse_id=record.greenhouse_id,
            reason_code=reason_code,
            optimizer_run_id=record.optimizer_run_id,
            message=record.outcome.message,
            now=now,
            dedup_window=timedelta(minutes=service.escalation_dedup_window_minutes),
        )
        metrics.ESCALATIONS_TOTAL.labels(record.greenhouse_id, reason_code.value).inc()

    # A fresh outcome supersedes the greenhouse's other open holds; an identical recurring fault
    # folds into its standing entry instead of superseding itself (spec 09).
    store.escalations.supersede(record.greenhouse_id, now=now, except_reason=reason_code)
    metrics.OPEN_ESCALATIONS.set(store.escalations.backlog())
