"""The planning cycle — every branch of read → gate → simulate → plan → validate → apply."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from langchain_core.runnables import RunnableLambda

from climate_optimizer import schema_validation
from climate_optimizer.config import Settings
from climate_optimizer.cycle import plan_record_payload, run_cycle
from climate_optimizer.dataaccess import PlatformError, WriteOutcome
from climate_optimizer.models import (
    Metric,
    OutcomeStatus,
    PlanRecord,
    ReasonCode,
    SetpointsPatch,
    TrajectoryPoint,
)
from climate_optimizer.params import default_twin_params
from climate_optimizer.planner import Planner, PlannerChain
from climate_optimizer.planner.chain import BackendOutput
from climate_optimizer.runtime import RuntimeState
from climate_optimizer.store import ServiceStore
from climate_optimizer.twin import PredictedPoint
from conftest import (
    StubPlatformClient,
    build_context,
    build_output,
    build_patch,
    build_plan,
    chain_factory,
    failing_chain,
    fake_chain,
)

NOW = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)
PARAMS = default_twin_params()


async def _run(
    *,
    client: StubPlatformClient | None = None,
    chain: PlannerChain | None = None,
    settings: Settings | None = None,
    store: ServiceStore | None = None,
    runtime: RuntimeState | None = None,
    on_demand: bool = False,
) -> PlanRecord:
    resolved = settings or Settings()
    return await run_cycle(
        "gh-a",
        settings=resolved,
        client=client or StubPlatformClient(resolved),
        planner=Planner(resolved, chain_factory=chain_factory(chain or fake_chain())),
        runtime=runtime or RuntimeState(resolved),
        store=store or ServiceStore(),
        params=PARAMS,
        now=NOW,
        on_demand=on_demand,
    )


def _off_forecast() -> list[PredictedPoint]:
    """A retained forecast wildly at odds with what the context reports as observed."""
    return [
        PredictedPoint(
            at=NOW + timedelta(hours=offset),
            temperature_c=90.0,
            relative_humidity_pct=100.0,
            co2_ppm=20000.0,
            par_umol_m2_s=5000.0,
            vpd_kpa=1.0,
            dli_mol_m2_day=5.0,
            soil_moisture_vwc={"bench-a": 0.45},
        )
        for offset in (-1, 1)
    ]


# -- the happy path ---------------------------------------------------------


async def test_a_clean_cycle_applies_the_immediate_bundle() -> None:
    client = StubPlatformClient()
    store = ServiceStore()

    record = await _run(client=client, store=store)

    assert record.outcome.status is OutcomeStatus.APPLIED
    assert record.plan is not None
    assert record.outcome.reason_code is None
    # Only the immediate bundle is written; the trajectory stays an in-memory artifact.
    assert len(client.submitted) == 1
    assert client.submitted[0][0] == "gh-a"
    assert client.submitted[0][1] == record.plan.immediate_setpoints


async def test_applying_updates_the_cross_cycle_memory() -> None:
    store = ServiceStore()
    record = await _run(store=store)
    state = store.fleet.get("gh-a")

    assert state.last_applied_plan_id == record.optimizer_run_id
    assert state.retained_trajectory is not None
    assert state.reference_forecast is not None
    assert store.last_successful_cycle_at == NOW


async def test_an_applied_record_names_no_source_plan() -> None:
    record = await _run()
    assert record.source_plan_id is None


async def test_a_controller_offline_write_still_counts_as_applied() -> None:
    client = StubPlatformClient(
        write=WriteOutcome.applied_ok(
            setpoints=None, controller_offline=True, message="recorded; controller offline"
        )
    )
    record = await _run(client=client)

    # Phase 2 recorded the intent and re-asserts on reconnect, so the cycle succeeded.
    assert record.outcome.status is OutcomeStatus.APPLIED


# -- pre-planner holds (plan is null) ---------------------------------------


async def test_an_unreachable_platform_holds_the_cycle() -> None:
    client = StubPlatformClient(
        read_error=PlatformError(ReasonCode.PLATFORM_UNAVAILABLE, "connection refused")
    )
    record = await _run(client=client)

    assert record.outcome.status is OutcomeStatus.ESCALATED
    assert record.outcome.reason_code is ReasonCode.PLATFORM_UNAVAILABLE
    assert record.plan is None


async def test_a_failed_input_gate_holds_before_planning() -> None:
    client = StubPlatformClient(context=build_context(freshness_age=10_000.0))
    record = await _run(client=client)

    assert record.outcome.reason_code is ReasonCode.INPUT_STALE
    assert record.plan is None
    assert client.submitted == []


async def test_an_accelerated_clock_holds_the_cycle() -> None:
    client = StubPlatformClient(context=build_context(time_scale=8.0))
    record = await _run(client=client)
    assert record.outcome.reason_code is ReasonCode.CLOCK_MODE_UNSUPPORTED


async def test_a_diverging_twin_holds_the_cycle() -> None:
    ctx = build_context()
    # Seed the twin outside its plausibility envelope (temperature caps at 90 °C).
    series = next(s for s in ctx.telemetry if s.metric is Metric.TEMPERATURE)
    for bucket in series.buckets:
        bucket.mean = 500.0

    record = await _run(client=StubPlatformClient(context=ctx))

    assert record.outcome.reason_code is ReasonCode.TWIN_DIVERGED
    assert record.plan is None


async def test_an_unreachable_planner_holds_the_cycle() -> None:
    record = await _run(chain=failing_chain())

    assert record.outcome.reason_code is ReasonCode.LLM_UNAVAILABLE
    assert record.plan is None


async def test_an_over_budget_context_holds_the_cycle() -> None:
    record = await _run(settings=Settings(planning={"context_token_budget": 5}))
    assert record.outcome.reason_code is ReasonCode.LLM_UNAVAILABLE


async def test_a_cycle_that_overruns_its_timeout_is_held() -> None:
    async def slow(_payload: dict[str, Any]) -> BackendOutput:
        await asyncio.sleep(0.5)
        return build_output()

    slow_chain: PlannerChain = RunnableLambda(slow)
    record = await _run(
        chain=slow_chain,
        settings=Settings(service={"cycle_timeout_seconds": 0.05}),
    )

    # The cadence is a ceiling: the loop self-heals to the next tick rather than wedging.
    assert record.outcome.reason_code is ReasonCode.CYCLE_TIMEOUT
    assert record.plan is None


# -- extended (nothing planned, nothing written) ----------------------------


async def test_absent_bounds_extend_the_baseline_without_calling_the_llm() -> None:
    ctx = build_context()
    ctx.setpoints.bounds = None
    client = StubPlatformClient(context=ctx)

    record = await _run(client=client)

    assert record.outcome.status is OutcomeStatus.EXTENDED
    assert record.outcome.reason_code is None
    assert record.plan is None
    assert client.submitted == []


async def test_a_settled_greenhouse_extends_on_the_next_cadence() -> None:
    client = StubPlatformClient()
    store = ServiceStore()

    first = await _run(client=client, store=store)
    second = await _run(client=client, store=store)

    assert first.outcome.status is OutcomeStatus.APPLIED
    # Identical inputs mean an identical forecast, so the state-change gate suppresses the call.
    assert second.outcome.status is OutcomeStatus.EXTENDED
    assert second.plan is None
    assert len(client.submitted) == 1


async def test_an_on_demand_cycle_bypasses_state_change_suppression() -> None:
    client = StubPlatformClient()
    store = ServiceStore()

    await _run(client=client, store=store)
    second = await _run(client=client, store=store, on_demand=True)

    # The operator asked for a fresh decision (spec 02).
    assert second.outcome.status is OutcomeStatus.APPLIED
    assert len(client.submitted) == 2


async def test_a_held_cycle_names_the_plan_left_in_force() -> None:
    client = StubPlatformClient()
    store = ServiceStore()

    applied = await _run(client=client, store=store)
    extended = await _run(client=client, store=store)

    assert extended.source_plan_id == applied.optimizer_run_id


# -- post-planner escalations (the plan is kept) ----------------------------


async def test_a_low_confidence_plan_is_surfaced_not_applied() -> None:
    client = StubPlatformClient()
    chain = fake_chain(build_output(build_plan(confidence=0.4)))

    record = await _run(client=client, chain=chain)

    assert record.outcome.reason_code is ReasonCode.LOW_CONFIDENCE
    assert record.plan is not None  # the rejected plan is kept for review
    assert client.submitted == []


async def test_an_out_of_bounds_target_is_a_constraint_violation() -> None:
    chain = fake_chain(build_output(build_plan(patch=build_patch(temperature_day_c=40.0))))
    record = await _run(chain=chain)

    assert record.outcome.reason_code is ReasonCode.CONSTRAINT_VIOLATION
    assert record.plan is not None


async def test_an_inconsistent_bundle_is_a_constraint_violation() -> None:
    patch = SetpointsPatch(humidity_low_pct=80.0, humidity_high_pct=40.0)
    record = await _run(chain=fake_chain(build_output(build_plan(patch=patch))))
    assert record.outcome.reason_code is ReasonCode.CONSTRAINT_VIOLATION


async def test_immediate_setpoints_must_match_the_first_trajectory_point() -> None:
    plan = build_plan()
    # Desynchronize the head of the trajectory from the bundle that would be written.
    plan.trajectory[0] = TrajectoryPoint(
        at=plan.trajectory[0].at, setpoints=build_patch(temperature_day_c=22.0)
    )

    record = await _run(chain=fake_chain(build_output(plan)))
    assert record.outcome.reason_code is ReasonCode.CONSTRAINT_VIOLATION


@pytest.mark.parametrize(
    "reason",
    [
        ReasonCode.BOUNDS_MISMATCH,
        ReasonCode.WRITE_UNAUTHORIZED,
        ReasonCode.CONTRACT_DRIFT,
        ReasonCode.PLATFORM_UNAVAILABLE,
    ],
)
async def test_a_rejected_write_escalates_with_the_write_reason(reason: ReasonCode) -> None:
    client = StubPlatformClient(write=WriteOutcome.escalated(reason, "rejected"))
    record = await _run(client=client)

    assert record.outcome.status is OutcomeStatus.ESCALATED
    assert record.outcome.reason_code is reason
    assert record.plan is not None


# -- twin fidelity ----------------------------------------------------------


async def test_a_single_bad_prediction_does_not_fault() -> None:
    store = ServiceStore()
    store.fleet.get("gh-a").last_forecast = _off_forecast()

    record = await _run(store=store)

    assert record.outcome.status is OutcomeStatus.APPLIED
    assert store.fleet.get("gh-a").consecutive_fidelity_breaches == 1


async def test_sustained_drift_faults_and_withholds_the_plan() -> None:
    store = ServiceStore()
    state = store.fleet.get("gh-a")
    state.last_forecast = _off_forecast()
    state.consecutive_fidelity_breaches = 2  # this cycle is the third in a row

    client = StubPlatformClient()
    record = await _run(client=client, store=store)

    assert record.outcome.reason_code is ReasonCode.TWIN_FIDELITY_FAULT
    assert record.plan is not None  # confidence is capped, but the plan is surfaced
    assert client.submitted == []


async def test_a_good_prediction_resets_the_breach_run() -> None:
    store = ServiceStore()
    state = store.fleet.get("gh-a")
    state.consecutive_fidelity_breaches = 2
    # A forecast that matches the observed context means a residual under the threshold.
    state.last_forecast = [
        PredictedPoint(
            at=NOW + timedelta(hours=offset),
            temperature_c=23.0,
            relative_humidity_pct=60.0,
            co2_ppm=1000.0,
            par_umol_m2_s=500.0,
            vpd_kpa=1.0,
            dli_mol_m2_day=5.0,
            soil_moisture_vwc={"bench-a": 0.45},
        )
        for offset in (-1, 1)
    ]

    record = await _run(store=store)

    assert state.consecutive_fidelity_breaches == 0
    assert record.outcome.status is OutcomeStatus.APPLIED


# -- the record and the escalation lifecycle --------------------------------


async def test_every_cycle_emits_a_contract_valid_record() -> None:
    for record in (
        await _run(),
        await _run(chain=failing_chain()),
        await _run(chain=fake_chain(build_output(build_plan(confidence=0.1)))),
    ):
        schema_validation.validate_plan_record(plan_record_payload(record))


async def test_a_held_record_serializes_plan_as_an_explicit_null() -> None:
    record = await _run(chain=failing_chain())
    payload = plan_record_payload(record)

    assert payload["plan"] is None
    assert "source_plan_id" not in payload  # absent on a cold-start hold


async def test_the_record_is_stored_as_the_greenhouses_latest() -> None:
    store = ServiceStore()
    record = await _run(store=store)
    assert store.plans.latest("gh-a") is record


async def test_an_escalated_cycle_opens_an_escalation() -> None:
    store = ServiceStore()
    await _run(store=store, chain=failing_chain())

    open_set = store.escalations.open_escalations()
    assert len(open_set) == 1
    assert open_set[0].reason_code is ReasonCode.LLM_UNAVAILABLE


async def test_a_repeated_fault_folds_into_one_standing_escalation() -> None:
    store = ServiceStore()
    await _run(store=store, chain=failing_chain())
    await _run(store=store, chain=failing_chain())

    open_set = store.escalations.open_escalations()
    assert len(open_set) == 1
    assert open_set[0].recurrence_count == 2


async def test_a_recovered_cycle_supersedes_the_standing_escalation() -> None:
    store = ServiceStore()
    await _run(store=store, chain=failing_chain())
    assert store.escalations.backlog() == 1

    await _run(store=store)

    assert store.escalations.backlog() == 0


async def test_the_record_stamps_the_active_backend() -> None:
    settings = Settings()
    runtime = RuntimeState(settings)
    runtime.set_model("mistral")

    record = await _run(settings=settings, runtime=runtime, chain=failing_chain())

    # A held cycle still records which backend would have run it (P3-OBS-1).
    assert record.backend.model == "mistral"
    assert record.backend.prompt_version == "v1"
