"""The planning cycle — every branch of read → gate → simulate → plan → validate → apply."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from langchain_core.runnables import RunnableLambda

from climate_optimizer.config import Settings
from climate_optimizer.domain.twin import PredictedPoint, default_twin_params
from climate_optimizer.infra import schema_validation
from climate_optimizer.infra.dataaccess import PlatformError, WriteOutcome
from climate_optimizer.models import (
    CycleStage,
    Metric,
    OutcomeStatus,
    PlanRecord,
    ReasonCode,
    SetpointsPatch,
    TrajectoryPoint,
)
from climate_optimizer.orchestration.cycle import plan_record_payload, run_cycle
from climate_optimizer.orchestration.runtime import RuntimeState
from climate_optimizer.orchestration.store import ServiceStore
from climate_optimizer.planner import Planner, PlannerChain
from climate_optimizer.planner.chain import BackendOutput
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
    now: datetime = NOW,
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
        now=now,
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


async def test_a_recorded_write_counts_as_applied() -> None:
    # A 202 — delivered, or held by Phase 2 for an offline controller and re-asserted on reconnect —
    # is a successful apply; the optimizer owns the intended state. (A 503, by contrast, records
    # nothing and escalates — see test_a_rejected_write_escalates_with_the_write_reason.)
    client = StubPlatformClient(
        write=WriteOutcome.applied_ok(setpoints=None, message="recorded (202)")
    )
    record = await _run(client=client)

    assert record.outcome.status is OutcomeStatus.APPLIED


# -- the resilience invariant: every cycle emits a record -------------------


async def test_an_unexpected_error_escalates_as_internal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A fault the pipeline never anticipated (here: the twin blowing up) must not vanish — the
    # cycle still emits a contract-valid, persisted, escalated record so an operator sees it.
    def boom(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("twin exploded")

    monkeypatch.setattr("climate_optimizer.orchestration.cycle.simulate", boom)

    store = ServiceStore()
    record = await _run(store=store)

    assert record.outcome.status is OutcomeStatus.ESCALATED
    assert record.outcome.reason_code is ReasonCode.INTERNAL_ERROR
    assert record.plan is None
    schema_validation.validate_plan_record(plan_record_payload(record))
    assert store.plans.latest("gh-a") is record
    assert store.escalations.backlog() >= 1


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


async def test_a_verbose_planner_error_is_bounded_on_the_record() -> None:
    # A backend that echoes a huge body must not flood the operator surface — the recorded outcome
    # message is capped for the escalation row (the full detail is logged).
    flood = RuntimeError("x" * 5000)
    record = await _run(chain=failing_chain(flood))

    assert record.outcome.reason_code is ReasonCode.LLM_UNAVAILABLE
    assert record.outcome.message is not None
    assert len(record.outcome.message) <= 300


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


async def test_a_decided_write_is_not_cancelled_by_the_cycle_timeout() -> None:
    # The cycle timeout bounds *deliberation*, not the commit. A write that outruns the timeout but
    # completes under its own deadline must still be recorded as applied — otherwise Phase 2 could
    # commit a revision this cycle reports as a timeout (P3-RESIL-1).
    class SlowWriteClient(StubPlatformClient):
        async def submit_setpoints(
            self,
            greenhouse_id: str,
            patch: SetpointsPatch,
            *,
            optimizer_run_id: UUID,
            still_active: Callable[[], bool] | None = None,
        ) -> WriteOutcome:
            await asyncio.sleep(1.3)  # outruns the deliberation-only timeout below
            return await super().submit_setpoints(
                greenhouse_id,
                patch,
                optimizer_run_id=optimizer_run_id,
                still_active=still_active,
            )

    client = SlowWriteClient()
    store = ServiceStore()
    # The timeout sits above deliberation (~0.4s cold) but well below the write's 1.3s: if the write
    # were still inside the timeout scope, this would escalate CYCLE_TIMEOUT instead of applying.
    record = await _run(
        client=client, store=store, settings=Settings(service={"cycle_timeout_seconds": 1.0})
    )

    assert record.outcome.status is OutcomeStatus.APPLIED
    assert len(client.submitted) == 1
    assert store.fleet.get("gh-a").last_applied_plan_id == record.optimizer_run_id
    assert store.last_successful_cycle_at == NOW


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


async def test_an_extended_cycle_refreshes_the_cadence_watchdog() -> None:
    # A successful extend is a running cycle, not a stall: the watchdog must advance so a stable
    # greenhouse never flips to cycle_stalled (contract: "applied/extended successfully").
    client = StubPlatformClient()
    store = ServiceStore()

    await _run(client=client, store=store, now=NOW)
    later = NOW + timedelta(hours=1)
    extended = await _run(client=client, store=store, now=later)

    assert extended.outcome.status is OutcomeStatus.EXTENDED
    assert store.last_successful_cycle_at == later


async def test_an_escalated_cycle_does_not_refresh_the_watchdog() -> None:
    # An escalation is not a successful cycle: the last-successful-cycle age must keep growing.
    client = StubPlatformClient()
    store = ServiceStore()

    await _run(client=client, store=store, now=NOW)
    later = NOW + timedelta(hours=1)
    escalated = await _run(
        client=StubPlatformClient(
            read_error=PlatformError(ReasonCode.PLATFORM_UNAVAILABLE, "down")
        ),
        store=store,
        now=later,
    )

    assert escalated.outcome.status is OutcomeStatus.ESCALATED
    assert store.last_successful_cycle_at == NOW


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


def _pausing_chain(runtime: RuntimeState, *, scope: str) -> PlannerChain:
    """A planner chain that pauses planning *from inside* ``propose`` — standing in for an operator
    who pauses while the LLM is thinking. The plan still comes back, so the cycle can only hold the
    write by re-reading the enable gate at its commit point."""

    def pause_then_plan(_payload: Any) -> BackendOutput:
        if scope == "global":
            runtime.set_enabled(False, reason="paused mid-cycle")
        else:
            runtime.set_greenhouse_enabled("gh-a", False, reason="paused mid-cycle")
        return build_output()

    return RunnableLambda(pause_then_plan)


async def test_a_global_pause_mid_cycle_holds_the_write() -> None:
    client = StubPlatformClient()
    runtime = RuntimeState(Settings())

    record = await _run(
        client=client, runtime=runtime, chain=_pausing_chain(runtime, scope="global")
    )

    # The pause landed after the planner ran but before the write: the commit-point gate turns it
    # into an extend, and nothing reaches Phase 2 (spec 09 — a disabled optimizer writes nothing).
    assert record.outcome.status is OutcomeStatus.EXTENDED
    assert record.outcome.reason_code is None
    assert record.plan is None
    assert client.submitted == []


async def test_a_per_greenhouse_pause_mid_cycle_holds_the_write() -> None:
    client = StubPlatformClient()
    runtime = RuntimeState(Settings())

    record = await _run(
        client=client, runtime=runtime, chain=_pausing_chain(runtime, scope="greenhouse")
    )

    assert record.outcome.status is OutcomeStatus.EXTENDED
    assert record.plan is None
    assert client.submitted == []


async def test_a_pause_during_the_write_holds_it() -> None:
    # The commit-point gate passed, then a pause landed *inside* the write — between service-token
    # acquisition and dispatch (the TOCTOU the mid-planning tests don't reach). The write path's own
    # re-check withholds it, so nothing reaches Phase 2 and no cross-cycle state is mutated (spec 09).
    runtime = RuntimeState(Settings())

    def pause() -> None:
        runtime.set_enabled(False, reason="paused during token fetch")

    client = StubPlatformClient(pause_before_write=pause)
    store = ServiceStore()

    record = await _run(client=client, runtime=runtime, store=store)

    assert record.outcome.status is OutcomeStatus.EXTENDED
    assert record.outcome.reason_code is None
    assert record.plan is None
    assert client.submitted == []
    # No bundle was written, so the applied-plan memory is untouched (the hold is still a valid
    # extend, so the cadence watchdog does advance — that is asserted separately).
    assert store.fleet.get("gh-a").last_applied_plan_id is None


# -- post-planner escalations (the plan is kept) ----------------------------


async def test_a_low_confidence_plan_is_surfaced_not_applied() -> None:
    client = StubPlatformClient()
    chain = fake_chain(build_output(build_plan(confidence=0.4)))

    record = await _run(client=client, chain=chain)

    assert record.outcome.reason_code is ReasonCode.LOW_CONFIDENCE
    assert record.plan is not None  # the rejected plan is kept for review
    assert client.submitted == []


async def test_a_post_planner_escalation_does_not_name_a_source_plan() -> None:
    # A prior cycle applied, so a source_plan_id *is* available; but a post-planner escalation
    # carries the plan it rejected, so it must not also name a held source (contract §3).
    client = StubPlatformClient()
    store = ServiceStore()

    applied = await _run(client=client, store=store)
    escalated = await _run(
        client=client,
        store=store,
        on_demand=True,  # bypass state-change suppression so the planner actually runs
        chain=fake_chain(build_output(build_plan(confidence=0.4))),
    )

    assert applied.source_plan_id is None
    assert escalated.outcome.reason_code is ReasonCode.LOW_CONFIDENCE
    assert escalated.plan is not None
    assert escalated.source_plan_id is None


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


# -- live stage progress ----------------------------------------------------


async def test_a_clean_cycle_advances_to_the_publish_stage() -> None:
    store = ServiceStore()
    await _run(store=store)
    # The stage is retained after the cycle so an idle greenhouse shows where it ended.
    assert store.current_stage("gh-a") is CycleStage.PUBLISH


async def test_an_unreachable_platform_stops_at_the_ingest_stage() -> None:
    store = ServiceStore()
    client = StubPlatformClient(
        read_error=PlatformError(ReasonCode.PLATFORM_UNAVAILABLE, "connection refused")
    )
    await _run(client=client, store=store)
    assert store.current_stage("gh-a") is CycleStage.INGEST


async def test_a_failed_input_gate_stops_at_the_quality_gate_stage() -> None:
    store = ServiceStore()
    await _run(
        client=StubPlatformClient(context=build_context(freshness_age=10_000.0)), store=store
    )
    assert store.current_stage("gh-a") is CycleStage.QUALITY_GATE


async def test_a_diverging_twin_stops_at_the_forecast_stage() -> None:
    ctx = build_context()
    series = next(s for s in ctx.telemetry if s.metric is Metric.TEMPERATURE)
    for bucket in series.buckets:
        bucket.mean = 500.0

    store = ServiceStore()
    await _run(client=StubPlatformClient(context=ctx), store=store)
    assert store.current_stage("gh-a") is CycleStage.FORECAST


async def test_an_unreachable_planner_stops_at_the_plan_stage() -> None:
    store = ServiceStore()
    await _run(store=store, chain=failing_chain())
    assert store.current_stage("gh-a") is CycleStage.PLAN


async def test_a_low_confidence_plan_stops_at_the_constrain_stage() -> None:
    store = ServiceStore()
    await _run(store=store, chain=fake_chain(build_output(build_plan(confidence=0.4))))
    assert store.current_stage("gh-a") is CycleStage.CONSTRAIN


# -- outcome reporting (the activity-feed audit channel) --------------------


async def test_an_escalated_cycle_is_reported_to_the_platform() -> None:
    client = StubPlatformClient()
    record = await _run(client=client, chain=failing_chain())

    assert record.outcome.status is OutcomeStatus.ESCALATED
    assert [r.optimizer_run_id for r in client.reported] == [record.optimizer_run_id]


async def test_an_applied_cycle_is_not_reported() -> None:
    # An applied plan already surfaces via its setpoint write; it must not double-report.
    client = StubPlatformClient()
    await _run(client=client)
    assert client.reported == []


async def test_an_extended_cycle_is_not_reported() -> None:
    # An extend writes nothing and is deliberately not a feed kind, so it must not report.
    runtime = RuntimeState(Settings())

    def pause() -> None:
        runtime.set_enabled(False, reason="paused during token fetch")

    client = StubPlatformClient(pause_before_write=pause)
    record = await _run(client=client, runtime=runtime)
    assert record.outcome.status is OutcomeStatus.EXTENDED
    assert client.reported == []


async def test_a_failing_outcome_report_does_not_break_the_cycle() -> None:
    # Reporting is best-effort telemetry: a failure is swallowed, and the cycle still records.
    client = StubPlatformClient(report_error=RuntimeError("platform down"))
    store = ServiceStore()
    record = await _run(client=client, store=store, chain=failing_chain())

    assert record.outcome.status is OutcomeStatus.ESCALATED
    assert store.plans.latest("gh-a") is record
