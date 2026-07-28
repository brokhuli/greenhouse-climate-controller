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
though every read surface stays live. The dispatch gate is not the last word: because a cycle awaits
the planner (an LLM call) between dispatch and its write, ``run_cycle`` **re-reads the same gate at
its commit point**, so a pause that lands mid-cycle still stops that cycle's setpoint write (spec 09).

**The sweep loop** applies escalation TTL expiry and prunes closed escalations and held records. It
runs *independently of the planning scheduler* precisely so it still fires while the optimizer is
disabled (spec 09) — a paused service must not accumulate an unbounded backlog.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from ..config import Settings
from ..domain.twin import TwinParams
from ..infra import metrics
from ..infra.dataaccess import PlatformClient, PlatformError
from ..models import PlanRecord
from ..planner import Planner
from .cycle import run_cycle
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

    # -- on-demand dispatch -------------------------------------------------

    def reserve(self, greenhouse_id: str, *, reason: str | None = None) -> UUID:
        """Reserve an out-of-band cycle and return the run id it will carry (``POST …/cycles``).

        Synchronous on purpose: the gates are checked and the single-flight guard is claimed **before**
        the request returns, so the ``202`` names a run that is already committed to dispatch and a
        concurrent second trigger is refused rather than racing. The caller then schedules
        :meth:`run_reserved` to execute the cycle *after* the response is sent — the operator is not
        made to wait out an LLM call, and the proxy hop never times out on a slow cycle. Raising leaves
        no reservation behind.

        The operator is asking for a fresh decision, so the cycle bypasses **only** state-change
        suppression; the enable gate, input gate, twin checks, crop-safe bounds, confidence gate, and
        Phase-2 write validation all still run (spec 02). Refused while paused or already planning.
        """
        if not self._runtime.is_greenhouse_active(greenhouse_id):
            raise OptimizerDisabledError(
                f"planning is disabled for {greenhouse_id} (service-wide or per-greenhouse)"
            )
        if self.is_in_flight(greenhouse_id):
            raise CycleInFlightError(f"{greenhouse_id} already has a cycle in flight")

        run_id = uuid4()
        self._in_flight.add(greenhouse_id)
        logger.info(
            "on-demand cycle reserved",
            extra={
                "event": "optimizer_cycle_triggered",
                "greenhouse_id": greenhouse_id,
                "optimizer_run_id": str(run_id),
                "reason": reason,
            },
        )
        return run_id

    async def run_reserved(self, greenhouse_id: str, run_id: UUID) -> None:
        """Execute a cycle already reserved by :meth:`reserve` — the deferred body of a trigger.

        Runs under the concurrency ceiling and always releases the single-flight guard :meth:`reserve`
        claimed. ``run_cycle`` records every outcome itself, so a raised exception here means a fault
        escaped the record path entirely (dispatch/semaphore) — logged, never swallowed, since there is
        no request left to surface it to.
        """
        try:
            async with self._semaphore:
                await self._run_cycle(greenhouse_id, run_id=run_id, on_demand=True)
        except Exception:
            logger.exception(
                "on-demand cycle raised outside the record path",
                extra={
                    "event": "optimizer_dispatch_error",
                    "greenhouse_id": greenhouse_id,
                    "optimizer_run_id": str(run_id),
                },
            )
        finally:
            self._in_flight.discard(greenhouse_id)

    async def _dispatch(self, greenhouse_id: str, *, on_demand: bool) -> PlanRecord:
        """Run one scheduled cycle under the concurrency ceiling and the single-flight guard."""
        self._in_flight.add(greenhouse_id)
        try:
            async with self._semaphore:
                return await self._run_cycle(greenhouse_id, on_demand=on_demand)
        finally:
            self._in_flight.discard(greenhouse_id)

    async def _run_cycle(
        self, greenhouse_id: str, *, run_id: UUID | None = None, on_demand: bool
    ) -> PlanRecord:
        """Invoke ``run_cycle`` with the scheduler's injected dependencies (the shared cycle body)."""
        return await run_cycle(
            greenhouse_id,
            settings=self._settings,
            client=self._client,
            planner=self._planner,
            runtime=self._runtime,
            store=self._store,
            params=self._params,
            run_id=run_id,
            on_demand=on_demand,
        )

    # -- loops --------------------------------------------------------------

    async def tick(self) -> list[str]:
        """One cadence tick: dispatch every eligible greenhouse concurrently.

        Returns the greenhouse ids actually dispatched (exposed for tests and for the log).
        """
        metrics.ENABLED.set(1 if self._runtime.enabled.enabled else 0)

        # Fleet discovery is a read, so it runs even while globally paused (read-only mode keeps
        # reads live, spec 09): the roster it records feeds the /fleet listing and the health
        # watchdog, both of which must know a greenhouse exists before dispatch resumes.
        try:
            fleet = await self._client.list_fleet()
        except PlatformError as err:
            logger.warning(
                "fleet discovery failed; skipping this tick",
                extra={"event": "optimizer_fleet_discovery_failed", "error": err.message},
            )
            return []
        # The roster keeps *every* discovered greenhouse (incl. offline) so the /fleet view and the
        # watchdog know it exists; dispatch, below, is what excludes the offline ones.
        self._store.known_greenhouse_ids.update(member.greenhouse_id for member in fleet)

        if not self._runtime.enabled.enabled:
            return []

        # An offline greenhouse (no telemetry ever seen) can only hold at the input gate, so
        # planning it just escalates every cycle — skip it here rather than surface a doomed hold.
        eligible = [
            member.greenhouse_id
            for member in fleet
            if member.online
            and self._runtime.is_greenhouse_active(member.greenhouse_id)
            and not self.is_in_flight(member.greenhouse_id)
        ]
        if not eligible:
            return []

        results = await asyncio.gather(
            *(self._dispatch(greenhouse_id, on_demand=False) for greenhouse_id in eligible),
            return_exceptions=True,
        )
        # run_cycle records every outcome itself, so a raised result means a fault escaped the
        # record path entirely (e.g. dispatch/semaphore) — log it rather than let gather swallow it.
        for greenhouse_id, result in zip(eligible, results, strict=True):
            if isinstance(result, Exception):
                logger.error(
                    "planning cycle raised outside the record path",
                    extra={
                        "event": "optimizer_dispatch_error",
                        "greenhouse_id": greenhouse_id,
                        "error": repr(result),
                    },
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
