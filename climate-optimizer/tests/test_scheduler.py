"""The cadence scheduler — concurrency ceiling, single flight, enable gating, and the sweep."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from langchain_core.runnables import RunnableLambda

from climate_optimizer.config import Settings
from climate_optimizer.dataaccess import PlatformError
from climate_optimizer.models import ReasonCode
from climate_optimizer.params import default_twin_params
from climate_optimizer.planner import Planner, PlannerChain
from climate_optimizer.planner.chain import BackendOutput
from climate_optimizer.runtime import RuntimeState
from climate_optimizer.scheduler import CycleInFlightError, OptimizerDisabledError, Scheduler
from climate_optimizer.store import ServiceStore
from conftest import StubPlatformClient, build_output, chain_factory, fake_chain

NOW = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)


def _scheduler(
    *,
    settings: Settings | None = None,
    client: StubPlatformClient | None = None,
    chain: PlannerChain | None = None,
    runtime: RuntimeState | None = None,
    store: ServiceStore | None = None,
) -> Scheduler:
    resolved = settings or Settings()
    return Scheduler(
        settings=resolved,
        client=client or StubPlatformClient(resolved),
        planner=Planner(resolved, chain_factory=chain_factory(chain or fake_chain())),
        runtime=runtime or RuntimeState(resolved),
        store=store or ServiceStore(),
        params=default_twin_params(),
    )


class _Gate:
    """A chain that blocks inside the planner until released, tracking concurrency while it runs.

    Cycles are dominated by synchronous twin simulation, so tests must wait on an observed
    condition rather than a fixed sleep — the simulation is slower than any sleep worth writing.
    """

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.live = 0
        self.peak = 0

    @property
    def chain(self) -> PlannerChain:
        async def gated(_payload: dict[str, Any]) -> BackendOutput:
            self.live += 1
            self.peak = max(self.peak, self.live)
            await self.release.wait()
            self.live -= 1
            return build_output()

        gated_chain: PlannerChain = RunnableLambda(gated)
        return gated_chain

    async def wait_for_live(self, count: int, *, timeout: float = 30.0) -> bool:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if self.live >= count:
                return True
            await asyncio.sleep(0.01)
        return False


# -- dispatch and gating ----------------------------------------------------


async def test_a_tick_dispatches_every_greenhouse_in_the_fleet() -> None:
    client = StubPlatformClient(fleet=["gh-a", "gh-b", "gh-c"])
    dispatched = await _scheduler(client=client).tick()

    assert sorted(dispatched) == ["gh-a", "gh-b", "gh-c"]
    assert sorted(client.reads) == ["gh-a", "gh-b", "gh-c"]


async def test_a_globally_disabled_service_starts_no_cycles() -> None:
    settings = Settings()
    runtime = RuntimeState(settings)
    runtime.set_enabled(False, reason="maintenance")
    client = StubPlatformClient(settings, fleet=["gh-a", "gh-b"])

    dispatched = await _scheduler(settings=settings, client=client, runtime=runtime).tick()

    # Read-only mode: no cycles, no writes, not even a fleet read.
    assert dispatched == []
    assert client.reads == []


async def test_a_paused_greenhouse_is_skipped_while_the_fleet_plans() -> None:
    settings = Settings()
    runtime = RuntimeState(settings)
    runtime.set_greenhouse_enabled("gh-a", False, reason="sensor swap")
    client = StubPlatformClient(settings, fleet=["gh-a", "gh-b"])

    dispatched = await _scheduler(settings=settings, client=client, runtime=runtime).tick()

    assert dispatched == ["gh-b"]


async def test_a_global_pause_overrides_a_greenhouse_left_enabled() -> None:
    settings = Settings()
    runtime = RuntimeState(settings)
    runtime.set_greenhouse_enabled("gh-a", True)
    runtime.set_enabled(False)

    assert await _scheduler(settings=settings, runtime=runtime).tick() == []


async def test_fleet_discovery_failure_skips_the_tick_without_crashing() -> None:
    client = StubPlatformClient(
        fleet_error=PlatformError(ReasonCode.PLATFORM_UNAVAILABLE, "registry down")
    )
    assert await _scheduler(client=client).tick() == []


async def test_a_failing_cycle_does_not_stop_the_others() -> None:
    def explode(_payload: dict[str, Any]) -> BackendOutput:
        raise RuntimeError("planner exploded")

    client = StubPlatformClient(fleet=["gh-a", "gh-b"])
    store = ServiceStore()
    exploding: PlannerChain = RunnableLambda(explode)
    scheduler = _scheduler(client=client, chain=exploding, store=store)

    dispatched = await scheduler.tick()

    # Both still ran and both recorded a held outcome rather than taking the loop down.
    assert sorted(dispatched) == ["gh-a", "gh-b"]
    assert set(store.plans.all_latest()) == {"gh-a", "gh-b"}


# -- concurrency and single flight ------------------------------------------


async def test_concurrency_is_bounded_by_max_concurrent_cycles() -> None:
    gate = _Gate()
    settings = Settings(service={"max_concurrent_cycles": 2})
    client = StubPlatformClient(settings, fleet=["gh-a", "gh-b", "gh-c", "gh-d"])
    scheduler = _scheduler(settings=settings, client=client, chain=gate.chain)

    task = asyncio.create_task(scheduler.tick())
    assert await gate.wait_for_live(2)
    # Give any unbounded third cycle a chance to slip through before sampling the ceiling.
    await asyncio.sleep(0.2)
    observed_peak = gate.peak
    gate.release.set()
    await task

    # The worker-pool ceiling keeps the shared LLM backend from being stampeded.
    assert observed_peak == 2


async def test_greenhouses_plan_concurrently_rather_than_serially() -> None:
    gate = _Gate()
    settings = Settings(service={"max_concurrent_cycles": 4})
    client = StubPlatformClient(settings, fleet=["gh-a", "gh-b", "gh-c"])
    scheduler = _scheduler(settings=settings, client=client, chain=gate.chain)

    task = asyncio.create_task(scheduler.tick())
    # All three in the planner at once: a slow cycle on one greenhouse does not delay the others.
    reached = await gate.wait_for_live(3)
    gate.release.set()
    await task

    assert reached


async def test_a_greenhouse_already_planning_refuses_a_second_cycle() -> None:
    gate = _Gate()
    scheduler = _scheduler(chain=gate.chain)

    task = asyncio.create_task(scheduler.trigger("gh-a"))
    assert await gate.wait_for_live(1)
    assert scheduler.is_in_flight("gh-a")

    with pytest.raises(CycleInFlightError):
        await scheduler.trigger("gh-a")

    gate.release.set()
    await task
    assert not scheduler.is_in_flight("gh-a")


async def test_a_tick_skips_a_greenhouse_that_is_already_planning() -> None:
    gate = _Gate()
    client = StubPlatformClient(fleet=["gh-a", "gh-b"])
    scheduler = _scheduler(client=client, chain=gate.chain)

    triggered = asyncio.create_task(scheduler.trigger("gh-a"))
    assert await gate.wait_for_live(1)

    tick = asyncio.create_task(scheduler.tick())
    assert await gate.wait_for_live(2)
    gate.release.set()

    dispatched = await tick
    await triggered

    assert dispatched == ["gh-b"]


# -- on-demand trigger ------------------------------------------------------


async def test_trigger_runs_a_cycle_and_returns_its_record() -> None:
    record = await _scheduler().trigger("gh-a", reason="operator check")
    assert record.greenhouse_id == "gh-a"


async def test_trigger_is_refused_while_the_service_is_paused() -> None:
    settings = Settings()
    runtime = RuntimeState(settings)
    runtime.set_enabled(False)

    with pytest.raises(OptimizerDisabledError):
        await _scheduler(settings=settings, runtime=runtime).trigger("gh-a")


async def test_trigger_is_refused_while_that_greenhouse_is_paused() -> None:
    settings = Settings()
    runtime = RuntimeState(settings)
    runtime.set_greenhouse_enabled("gh-a", False)

    with pytest.raises(OptimizerDisabledError):
        await _scheduler(settings=settings, runtime=runtime).trigger("gh-a")


# -- the sweep --------------------------------------------------------------


async def test_the_sweep_expires_and_prunes() -> None:
    settings = Settings(service={"escalation_ttl_minutes": 1, "escalation_retention_minutes": 1})
    store = ServiceStore()
    store.escalations.raise_escalation(
        greenhouse_id="gh-a",
        reason_code=ReasonCode.INPUT_STALE,
        optimizer_run_id=uuid4(),
        message="held",
        now=NOW,
        dedup_window=timedelta(minutes=60),
    )
    scheduler = _scheduler(settings=settings, store=store)

    expired, _pruned, _records = await scheduler.sweep_once(NOW + timedelta(minutes=5))

    assert expired == 1
    assert store.escalations.backlog() == 0


async def test_the_sweep_runs_while_the_optimizer_is_paused() -> None:
    settings = Settings(service={"escalation_ttl_minutes": 1})
    runtime = RuntimeState(settings)
    runtime.set_enabled(False)
    store = ServiceStore()
    store.escalations.raise_escalation(
        greenhouse_id="gh-a",
        reason_code=ReasonCode.INPUT_STALE,
        optimizer_run_id=uuid4(),
        message="held",
        now=NOW,
        dedup_window=timedelta(minutes=60),
    )
    scheduler = _scheduler(settings=settings, runtime=runtime, store=store)

    # A paused service must not accumulate an unbounded backlog (spec 09).
    expired, _pruned, _records = await scheduler.sweep_once(NOW + timedelta(minutes=5))
    assert expired == 1


# -- lifecycle --------------------------------------------------------------


async def test_start_and_stop_are_idempotent_and_clean() -> None:
    scheduler = _scheduler(settings=Settings(planning={"cycle_interval_minutes": 60}))
    scheduler.start()
    scheduler.start()  # second call is a no-op
    await asyncio.sleep(0.01)
    await scheduler.stop()
    await scheduler.stop()
