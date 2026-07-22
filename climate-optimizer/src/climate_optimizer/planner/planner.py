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

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from ..config import Settings
from ..models import Horizon, PlanningContext, Setpoints
from ..twin import PredictedPoint
from .chain import BackendOutput, PlannerChain, build_chain
from .serializer import PlanContextPayload, build_plan_context

logger = logging.getLogger(__name__)

# How close to a day-schedule flip the cycle window must be to earn the extended horizon (spec 04).
_DAY_BOUNDARY_PROXIMITY_SECONDS = 4 * 3600
_SECONDS_PER_DAY = 86400


class PlannerUnavailableError(Exception):
    """The planner produced no usable plan — the cycle is held with ``llm_unavailable``.

    Covers both a backend that could not be reached (with no fallback, or the fallback also failing)
    and a response that could not be parsed into an ``OptimizerPlan``: either way this cycle has no
    plan, and ``llm_unavailable`` is the canonical planner-raised code (spec 10).
    """


@dataclass(frozen=True)
class PlanProposal:
    """A produced plan plus the accounting worth logging for the cycle."""

    output: BackendOutput
    context: PlanContextPayload


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
        unchanged — an over-budget context is a configuration fault, not a backend outage.
        """
        payload = build_plan_context(
            ctx,
            baseline_forecast=baseline_forecast,
            horizon=horizon,
            settings=self._settings,
            now=now,
        )

        try:
            output = await self.chain_for(model).ainvoke({"plan_context": payload.text})
        except Exception as err:  # noqa: BLE001 — any backend/parse failure holds the cycle
            raise PlannerUnavailableError(f"planner produced no plan: {err}") from err

        if output.role.value != "primary":
            logger.warning(
                "planner failed over to the fallback backend",
                extra={
                    "event": "optimizer_planner_failover",
                    "greenhouse_id": ctx.greenhouse_id,
                    "provider": output.provider.value,
                    "model": output.model,
                },
            )

        return PlanProposal(output=output, context=payload)
