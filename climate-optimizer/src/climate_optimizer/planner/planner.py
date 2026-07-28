"""The planner front end (spec 04) — adaptive horizon, context assembly, chain invocation.

This is the seam the cycle calls: it turns a planning context plus the twin's baseline forecast into
a parsed :class:`~climate_optimizer.planner.chain.BackendOutput`, or raises
:class:`PlannerUnavailableError` when the backend could not produce one.

The **state-change gate** deliberately lives outside this module: it needs the greenhouse's retained
reference forecast, which is cycle state, so the cycle evaluates it and simply does not call the
planner on a suppressed cadence.

The chain is built lazily and cached per model id, so an operator's runtime model switch takes effect
on the **next** cycle (spec 10) without rebuilding the chain every cadence.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from langchain_core.exceptions import OutputParserException
from pydantic import ValidationError

from ..config import Settings
from ..domain.constraints import clamp_to_bounds
from ..domain.twin import PredictedPoint
from ..models import (
    Horizon,
    OptimizerPlan,
    PlanningContext,
    Setpoints,
    SetpointsPatch,
    TrajectoryPoint,
)
from .chain import BackendDraft, BackendOutput, PlannerChain, build_chain
from .serializer import PlanContextPayload, build_plan_context

logger = logging.getLogger(__name__)

# How close to a day-schedule flip the cycle window must be to earn the extended horizon (spec 04).
_DAY_BOUNDARY_PROXIMITY_SECONDS = 4 * 3600
_SECONDS_PER_DAY = 86400

# The planner-hold message is shown on the operator surface, so it must stay a concise single line.
# LangChain's structured-output parser echoes the *entire* model completion into its
# OutputParserException; surfacing that raw floods the escalation row (P3-OBS-1). The full error is
# logged; the operator gets the bounded headline.
_MAX_PLANNER_ERROR_CHARS = 200


def _summarize_planner_error(err: Exception) -> str:
    """A concise, single-line hold message for a planner failure — no echoed model completion.

    LangChain's parse error reads ``Failed to parse OptimizerPlan from completion {…}. Got: {detail}``.
    The ``{…}`` is the entire echoed model output (floods the escalation row), but the trailing
    ``Got: {detail}`` names the offending field — the actionable part. Drop only the completion body,
    keep the detail.
    """
    text = " ".join(str(err).split())
    head_marker = " from completion "
    detail_marker = ". Got:"
    if head_marker in text and detail_marker in text:
        head = text.split(head_marker, 1)[0]
        detail = text.split(detail_marker, 1)[1].strip()
        text = f"{head}: {detail}"
    elif head_marker in text:
        text = text.split(head_marker, 1)[0]
    if len(text) > _MAX_PLANNER_ERROR_CHARS:
        text = text[: _MAX_PLANNER_ERROR_CHARS - 1].rstrip() + "…"
    return f"planner produced no plan: {text}"


def _log_no_plan(greenhouse_id: str, model: str, err: Exception) -> None:
    """Log the full failure (incl. the echoed completion) for debugging; the operator sees the summary."""
    logger.warning(
        "planner produced no usable plan",
        extra={
            "event": "optimizer_planner_unavailable",
            "greenhouse_id": greenhouse_id,
            "model": model,
            "error_type": type(err).__name__,
            "error": str(err),
        },
    )


class PlannerUnavailableError(Exception):
    """The backend could not be reached, or produced no response — held with ``llm_unavailable``.

    The backend was unreachable (with no fallback, or the fallback also failing) or otherwise returned
    no usable response. A response that *was* returned but could not be parsed into an ``OptimizerPlan``
    is a distinct case — see :class:`PlannerParseError` — so an operator can tell an outage apart from a
    malformed completion (spec 10).
    """


class PlannerParseError(Exception):
    """The backend responded, but the completion would not parse into a valid ``SetpointDecision``.

    Held with ``plan_unparseable`` — distinct from an unreachable backend (:class:`PlannerUnavailableError`):
    the LLM is up, its output is just off-schema (a bad field type, a hallucinated key).
    """


class PlannerNoChange(Exception):
    """The model deliberately proposed *no* setpoint change — a valid hold, not an error.

    An empty ``SetpointDecision.setpoints`` means "no change earns its cost this cycle" (spec 06 §1).
    The cycle reads this as an :class:`~climate_optimizer.models.OutcomeStatus.EXTENDED` outcome — the
    last applied bundle stays in force and nothing is written — rather than an escalation. It falls
    out of the shrunk output naturally: a constrained-decoding backend can return ``{}``, and we treat
    that as the decision it is instead of a malformed plan.
    """


@dataclass(frozen=True)
class PlanProposal:
    """A produced plan plus the accounting worth logging for the cycle."""

    output: BackendOutput
    context: PlanContextPayload
    clamped_fields: tuple[str, ...] = field(default_factory=tuple)


def _hhmm_to_seconds(hhmm: str) -> int:
    hours, minutes = hhmm.split(":")
    return int(hours) * 3600 + int(minutes) * 60


def choose_horizon(now: datetime, setpoints: Setpoints, settings: Settings) -> Horizon:
    """The adaptive planning window: the configured horizon, doubled near a day-schedule flip.

    Default 12 h, extended to 24 h only when the window crosses a day boundary — within 4 h of the
    ``day_start`` / ``day_end`` flip the controller schedules against (spec 04).
    """
    base_hours = settings.planning.horizon_hours
    second_of_day = now.hour * 3600 + now.minute * 60 + now.second
    boundaries = (_hhmm_to_seconds(setpoints.day_start), _hhmm_to_seconds(setpoints.day_end))
    nearest = min((boundary - second_of_day) % _SECONDS_PER_DAY for boundary in boundaries)
    hours = base_hours * 2 if nearest <= _DAY_BOUNDARY_PROXIMITY_SECONDS else base_hours
    return Horizon(start=now, end=now + timedelta(hours=hours))


class Planner:
    """Builds the plan context and invokes the LangChain planner chain."""

    def __init__(
        self,
        settings: Settings,
        *,
        chain_factory: Callable[[str], PlannerChain] | None = None,
    ) -> None:
        self._settings = settings
        self._chain_factory = chain_factory or (lambda model: build_chain(settings, model=model))
        self._chains: dict[str, PlannerChain] = {}

    def chain_for(self, model: str) -> PlannerChain:
        """The chain for one model id, constructed once and reused."""
        chain = self._chains.get(model)
        if chain is None:
            chain = self._chain_factory(model)
            self._chains[model] = chain
        return chain

    async def propose(
        self,
        ctx: PlanningContext,
        *,
        baseline_forecast: list[PredictedPoint],
        horizon: Horizon,
        model: str,
        now: datetime,
    ) -> PlanProposal:
        """Serialize the context and invoke the planner; raise on any failure to produce a plan.

        A :class:`~climate_optimizer.planner.serializer.ContextBudgetExceededError` propagates
        unchanged — an over-budget context is a configuration fault, not a backend outage. The chain
        call is bounded by ``llm.request_timeout_seconds`` — a sub-budget under the cycle timeout that
        attributes a slow backend to ``llm_unavailable`` rather than a whole-cycle ``cycle_timeout``.
        """
        payload = build_plan_context(
            ctx,
            baseline_forecast=baseline_forecast,
            horizon=horizon,
            settings=self._settings,
            now=now,
        )

        try:
            draft = await asyncio.wait_for(
                self.chain_for(model).ainvoke({"plan_context": payload.text}),
                timeout=self._settings.llm.request_timeout_seconds,
            )
        except TimeoutError as err:
            # The backend did not answer within its own budget: an outage-class hold, but named so an
            # operator sees the LLM was the slow part (distinct from a whole-cycle timeout).
            _log_no_plan(ctx.greenhouse_id, model, err)
            raise PlannerUnavailableError(
                "planner produced no plan: llm request exceeded "
                f"{self._settings.llm.request_timeout_seconds:g}s"
            ) from err
        except (OutputParserException, ValidationError) as err:
            # The backend responded; the completion is just off-schema. Distinct from an outage so the
            # operator sees `plan_unparseable`, not a false "backend unreachable".
            _log_no_plan(ctx.greenhouse_id, model, err)
            raise PlannerParseError(_summarize_planner_error(err)) from err
        except Exception as err:  # noqa: BLE001 — any other backend failure holds the cycle
            _log_no_plan(ctx.greenhouse_id, model, err)
            raise PlannerUnavailableError(_summarize_planner_error(err)) from err

        if draft.role.value != "primary":
            logger.warning(
                "planner failed over to the fallback backend",
                extra={
                    "event": "optimizer_planner_failover",
                    "greenhouse_id": ctx.greenhouse_id,
                    "provider": draft.provider.value,
                    "model": draft.model,
                },
            )

        output, clamped_fields = self._assemble(draft, ctx=ctx, horizon=horizon)
        return PlanProposal(output=output, context=payload, clamped_fields=clamped_fields)

    def _assemble(
        self, draft: BackendDraft, *, ctx: PlanningContext, horizon: Horizon
    ) -> tuple[BackendOutput, tuple[str, ...]]:
        """Turn the model's shrunk decision into a full, guardrail-safe ``OptimizerPlan``.

        The model owns only the *semantic* choice — which targets to move; the code owns everything
        mechanical. Dropping absent/null fields, clamping to the crop-safe envelope, stamping
        ``horizon.start``, and building the single-point trajectory here means the timestamp-echo,
        ``immediate_setpoints ≡ trajectory[0]``, and empty-patch failure modes can never reach the
        model. An empty decision is a deliberate hold (:class:`PlannerNoChange`).
        """
        candidate = draft.decision.setpoints.model_dump(exclude_none=True)
        if not candidate:
            raise PlannerNoChange("model proposed no setpoint change")

        clamp = clamp_to_bounds(SetpointsPatch(**candidate), ctx.setpoints.bounds)
        explanation = draft.decision.explanation
        if clamp.clamped_fields:
            explanation = f"{explanation} [clamped to crop-safe: {', '.join(clamp.clamped_fields)}]"

        plan = OptimizerPlan(
            trajectory=[TrajectoryPoint(at=horizon.start, setpoints=clamp.patch)],
            immediate_setpoints=clamp.patch,
            confidence=draft.decision.confidence,
            explanation=explanation,
        )
        output = BackendOutput(
            plan=plan, provider=draft.provider, model=draft.model, role=draft.role
        )
        return output, clamp.clamped_fields
