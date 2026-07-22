"""The cadence scheduler (spec 02 §Scheduling, spec 09) — two independent background loops.

**The planning loop** dispatches a cycle per greenhouse on a fixed cadence. A planning cycle is
*scoped* to one greenhouse; the fleet is planned **concurrently**, so a slow cycle on one greenhouse
never delays the others and aggregate fleet time does not grow linearly with N (P3-SCAL-1,
P3-PERF-1). Two guards bound that concurrency:

* ``max_concurrent_cycles`` — a worker-pool ceiling that keeps the shared LLM backend and the Phase-2
  API from being stampeded.
* **single-flight per greenhouse** — parallelism is *across* greenhouses; within any one greenhouse
  at most one cycle is ever in flight, scheduled or on-demand.

The loop is gated on the enable flags, composed as an AND with the global taking precedence: a
greenhouse is dispatched only when the service is globally enabled *and* that greenhouse is enabled.
While globally disabled the optimizer is **read-only** — no cycles start and the applier is inert —
though every read surface stays live.

**The sweep loop** applies escalation TTL expiry and prunes closed escalations and held records. It
runs *independently of the planning scheduler* precisely so it still fires while the optimizer is
disabled (spec 09) — a paused service must not accumulate an unbounded backlog.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import UTC, datetime, timedelta

from . import metrics
from .config import Settings
from .cycle import run_cycle
from .dataaccess import PlatformClient, PlatformError
from .models import PlanRecord
from .params import TwinParams
from .planner import Planner
from .runtime import RuntimeState
from .store import ServiceStore

logger = logging.getLogger(__name__)

# How often the escalation sweep runs. Independent of the planning cadence so a paused or
# long-cadence service still expires and prunes on a predictable rhythm.
_SWEEP_INTERVAL_SECONDS = 60.0


class CycleInFlightError(Exception):
    """That greenhouse already has a cycle in flight — refused rather than queued behind it."""


class OptimizerDisabledError(Exception):
    """Planning is paused, service-wide or for this greenhouse (read-only mode)."""


class Scheduler:
    """Owns the planning cadence, the single-flight guard, and the escalation sweep."""

    def __init__(
        self,
        *,
        settings: Settings,
        client: PlatformClient,
        planner: Planner,
        runtime: RuntimeState,
        store: ServiceStore,
        params: TwinParams,
    ) -> None:
        self._settings = settings
        self._client = client
        self._planner = planner
        self._runtime = runtime
        self._store = store
        self._params = params
        self._semaphore = asyncio.Semaphore(settings.service.max_concurrent_cycles)
        self._in_flight: set[str] = set()
        self._tasks: list[asyncio.Task[None]] = []

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        """Start the planning and sweep loops (called from the service lifespan)."""
        if self._tasks:
            return
        self._tasks = [
            asyncio.create_task(self._planning_loop(), name="optimizer-planning-loop"),
            asyncio.create_task(self._sweep_loop(), name="optimizer-sweep-loop"),
        ]

    async def stop(self) -> None:
        """Cancel both loops and wait for them to unwind."""
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks = []

    # -- introspection ------------------------------------------------------

    def is_in_flight(self, greenhouse_id: str) -> bool:
        return greenhouse_id in self._in_flight

    # -- dispatch -----------------------------------------------------------

    async def trigger(self, greenhouse_id: str, *, reason: str | None = None) -> PlanRecord:
        """Run an out-of-band cycle for one greenhouse (``POST …/cycles``).

        The operator is asking for a fresh decision, so it bypasses **only** state-change
        suppression; the enable gate, input gate, twin checks, crop-safe bounds, confidence gate, and
        Phase-2 write validation all still run (spec 02). Refused while paused or already planning.
        """
        if not self._runtime.is_greenhouse_active(greenhouse_id):
            raise OptimizerDisabledError(
                f"planning is disabled for {greenhouse_id} (service-wide or per-greenhouse)"
            )
        if self.is_in_flight(greenhouse_id):
            raise CycleInFlightError(f"{greenhouse_id} already has a cycle in flight")

        logger.info(
            "on-demand cycle requested",
            extra={
                "event": "optimizer_cycle_triggered",
                "greenhouse_id": greenhouse_id,
                "reason": reason,
            },
        )
        return await self._dispatch(greenhouse_id, on_demand=True)

    async def _dispatch(self, greenhouse_id: str, *, on_demand: bool) -> PlanRecord:
        """Run one cycle under the concurrency ceiling and the single-flight guard."""
        self._in_flight.add(greenhouse_id)
        try:
            async with self._semaphore:
                return await run_cycle(
                    greenhouse_id,
                    settings=self._settings,
                    client=self._client,
                    planner=self._planner,
                    runtime=self._runtime,
                    store=self._store,
                    params=self._params,
                    on_demand=on_demand,
                )
        finally:
            self._in_flight.discard(greenhouse_id)

    # -- loops --------------------------------------------------------------

    async def tick(self) -> list[str]:
        """One cadence tick: dispatch every eligible greenhouse concurrently.

        Returns the greenhouse ids actually dispatched (exposed for tests and for the log).
        """
        metrics.ENABLED.set(1 if self._runtime.enabled.enabled else 0)
        if not self._runtime.enabled.enabled:
            return []

        try:
            fleet = await self._client.list_greenhouse_ids()
        except PlatformError as err:
            logger.warning(
                "fleet discovery failed; skipping this tick",
                extra={"event": "optimizer_fleet_discovery_failed", "error": err.message},
            )
            return []

        eligible = [
            greenhouse_id
            for greenhouse_id in fleet
            if self._runtime.is_greenhouse_active(greenhouse_id)
            and not self.is_in_flight(greenhouse_id)
        ]
        if not eligible:
            return []

        await asyncio.gather(
            *(self._dispatch(greenhouse_id, on_demand=False) for greenhouse_id in eligible),
            return_exceptions=True,
        )
        return eligible

    async def _planning_loop(self) -> None:
        interval = self._settings.planning.cycle_interval_minutes * 60.0
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                # A tick must never kill the loop; the next cadence is the recovery path.
                logger.exception("planning tick failed", extra={"event": "optimizer_tick_failed"})
            await asyncio.sleep(interval)

    async def sweep_once(self, now: datetime | None = None) -> tuple[int, int, int]:
        """Expire and prune the escalation surface (spec 09 §Escalation lifecycle)."""
        service = self._settings.service
        moment = now or datetime.now(UTC)
        result = self._store.sweep(
            moment,
            ttl=timedelta(minutes=service.escalation_ttl_minutes),
            retention=timedelta(minutes=service.escalation_retention_minutes),
        )
        metrics.OPEN_ESCALATIONS.set(self._store.escalations.backlog())
        expired, pruned, records = result
        if expired or pruned or records:
            logger.info(
                "escalation sweep",
                extra={
                    "event": "optimizer_escalation_sweep",
                    "expired": expired,
                    "escalations_pruned": pruned,
                    "records_pruned": records,
                },
            )
        return result

    async def _sweep_loop(self) -> None:
        while True:
            try:
                await self.sweep_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "escalation sweep failed", extra={"event": "optimizer_sweep_failed"}
                )
            await asyncio.sleep(_SWEEP_INTERVAL_SECONDS)
