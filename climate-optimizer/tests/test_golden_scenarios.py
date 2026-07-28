"""Spec-08 §2 golden-scenario library — the named scenarios, run as one consolidated suite.

Each entry pins a **concrete v1 behavior** (spec 08 §2), not a generic happy path: the
trajectory-shaping scenarios roll the deterministic twin (spec 03) forward and assert the coupled
climate moves as the governing equations require; the robustness scenarios drive a full cycle
(spec 02/06/07) and assert the correct gate trips and the plan is held. This is the twin-side analog
of the controller's seeded-HAL determinism (P1-TEST-2 / P3-TEST-1): the same inputs, the same output,
every run.

The per-module unit suites (``test_twin`` / ``test_cycle``) still exercise these mechanisms in
isolation; this file is the single place the spec-08 §2 library is enumerated end-to-end, so a reader
can see every named scenario and its expected behavior in one registry.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from climate_optimizer.config import Settings
from climate_optimizer.domain.twin import (
    PredictedPoint,
    TwinState,
    default_twin_params,
    simulate,
    solar_fraction,
)
from climate_optimizer.models import Metric, PlanRecord, ReasonCode
from climate_optimizer.orchestration.cycle import run_cycle
from climate_optimizer.orchestration.runtime import RuntimeState
from climate_optimizer.orchestration.store import ServiceStore
from climate_optimizer.planner import Planner, choose_horizon
from conftest import (
    StubPlatformClient,
    build_context,
    build_draft,
    build_patch,
    build_setpoints,
    chain_factory,
    fake_chain,
)

PARAMS = default_twin_params()
SETPOINTS = build_setpoints()  # day 06:00–20:00, day/night 24/18 °C
NOW = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)

# climate seed order matches TwinState.climate: [temperature_c, rh_pct, co2_ppm, par_umol_m2_s]
_TEMP, _RH, _CO2, _PAR = 0, 1, 2, 3


def _seed(
    clock: datetime, climate: list[float], *, dli: float = 5.0, soil: float = 0.45
) -> TwinState:
    return TwinState(
        climate=np.array(climate, dtype=np.float64),
        soil={"bench-a": soil},
        dli_mol=dli,
        clock=clock,
        day_ordinal=clock.toordinal(),
        valve_open={"bench-a": False},
        last_close_elapsed_s={"bench-a": -1e18},
    )


def _roll(
    clock: datetime,
    climate: list[float],
    *,
    hours: float,
    out_minutes: float,
    dli: float = 5.0,
) -> list[PredictedPoint]:
    return simulate(
        _seed(clock, climate, dli=dli),
        SETPOINTS,
        end=clock + timedelta(hours=hours),
        params=PARAMS,
        max_step_minutes=5,
        output_interval_minutes=out_minutes,
    ).points


# -- trajectory-shaping scenarios (roll the twin, assert the coupled climate) -----------------------


def _steady_state() -> None:
    """Held at its fixed point, the twin does not drift (the exponential update is exact there)."""
    # A night window (02:00 → 05:00, before sunrise): T_set is the 18 °C night setpoint, no solar.
    points = _roll(
        datetime(2026, 6, 17, 2, tzinfo=UTC),
        [18.0, 60.0, 420.0, 0.0],
        hours=3,
        out_minutes=30,
        dli=0.0,
    )
    tail = [p.temperature_c for p in points[-3:]]
    assert max(tail) - min(tail) < 0.01  # settled to the fixed point and holding


def _sunrise_sunset_diurnal() -> None:
    """Solar half-sine drives PAR up then down, zero at night; DLI accumulates and resets at midnight."""
    # The disturbance itself (spec 03 §1.4): zero before sunrise / after sunset, rising through morning.
    assert solar_fraction(3 * 3600, PARAMS) == 0.0
    assert solar_fraction(21 * 3600, PARAMS) == 0.0
    assert solar_fraction(13 * 3600, PARAMS) > solar_fraction(7 * 3600, PARAMS) > 0.0

    # 12:00 → 02:00 next day crosses UTC midnight.
    points = _roll(NOW, [22.0, 60.0, 1000.0, 500.0], hours=14, out_minutes=60)
    midday = points[1]  # 13:00
    night = next(p for p in points if p.at.hour == 23)
    after_midnight = next(p for p in points if p.at.hour == 0)
    daytime = next(p for p in points if p.at.hour == 15)

    assert midday.par_umol_m2_s > 0.0  # natural light during the day
    assert night.par_umol_m2_s < 1.0  # dark at night
    assert after_midnight.dli_mol_m2_day < 0.5  # DLI reset at UTC-of-day midnight
    assert daytime.temperature_c > night.temperature_c  # day T_set (24) > night T_set (18)


def _venting_coupling() -> None:
    """A cooling call co-drops temperature AND CO2 AND RH together; the CO2 injector stays off.

    Seeded hot (sustained cooling → roof vents/fans maxed), with RH above the mister band so misting
    does not fight the venting, and CO2 *below* target: while vents exceed
    ``co2_vent_interlock_threshold_pct`` the injector is forced off, so CO2 falls with the venting
    instead of being driven up toward target.
    """
    seed = [80.0, 90.0, 500.0, 800.0]
    points = _roll(datetime(2026, 6, 17, 13, tzinfo=UTC), seed, hours=0.25, out_minutes=0.25)
    cooling = points[3]  # ~45 s in, venting in full effect

    assert cooling.temperature_c < seed[_TEMP]  # cooling drops temperature
    assert cooling.relative_humidity_pct < seed[_RH]  # the coupling co-drops RH
    assert cooling.co2_ppm < seed[_CO2]  # and CO2 — proving the injector is interlocked off


def _misting_coupling() -> None:
    """Misters raise RH and drop temperature together (+RH / −T coupling)."""
    seed = [
        24.0,
        30.0,
        1000.0,
        400.0,
    ]  # at the day setpoint (heater/cooling idle), RH below the band
    points = _roll(datetime(2026, 6, 17, 13, tzinfo=UTC), seed, hours=1, out_minutes=15, dli=10.0)
    settled = points[2]  # ~30 min, misting engaged

    assert settled.relative_humidity_pct > seed[_RH]  # misters raise RH
    assert settled.temperature_c < seed[_TEMP]  # and drop temperature together


# -- robustness scenarios (drive a cycle, assert the gate trips and the plan is held) ---------------


async def _run_cycle(
    *,
    client: StubPlatformClient | None = None,
    chain: object | None = None,
    store: ServiceStore | None = None,
) -> PlanRecord:
    settings = Settings()
    return await run_cycle(
        "gh-a",
        settings=settings,
        client=client or StubPlatformClient(settings),
        planner=Planner(settings, chain_factory=chain_factory(chain or fake_chain())),  # type: ignore[arg-type]
        runtime=RuntimeState(settings),
        store=store or ServiceStore(),
        params=PARAMS,
        now=NOW,
    )


def _off_forecast() -> list[PredictedPoint]:
    """A retained forecast wildly at odds with the observed context (a sustained residual)."""
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


async def _stale_input() -> None:
    """Stale telemetry trips the input gate before planning — a plan-less hold."""
    record = await _run_cycle(
        client=StubPlatformClient(context=build_context(freshness_age=10_000.0))
    )
    assert record.outcome.reason_code is ReasonCode.INPUT_STALE
    assert record.plan is None


async def _sensor_dropout() -> None:
    """A dropped required metric trips the input gate as incomplete — a plan-less hold."""
    record = await _run_cycle(
        client=StubPlatformClient(context=build_context(drop_metric=Metric.CO2))
    )
    assert record.outcome.reason_code is ReasonCode.INPUT_INCOMPLETE
    assert record.plan is None


async def _numerical_divergence() -> None:
    """A seed outside the plausibility envelope trips the twin guard: twin_diverged, no plan."""
    ctx = build_context()
    series = next(s for s in ctx.telemetry if s.metric is Metric.TEMPERATURE)
    for bucket in series.buckets:
        bucket.mean = 500.0  # past the 90 °C envelope
    record = await _run_cycle(client=StubPlatformClient(context=ctx))
    assert record.outcome.reason_code is ReasonCode.TWIN_DIVERGED
    assert record.plan is None


async def _residual_fidelity_fault() -> None:
    """Sustained one-step residual raises twin_fidelity_fault; confidence is capped, plan surfaced."""
    store = ServiceStore()
    state = store.fleet.get("gh-a")
    state.last_forecast = _off_forecast()
    state.consecutive_fidelity_breaches = 2  # this cycle is the third breach in a row
    record = await _run_cycle(store=store)
    assert record.outcome.reason_code is ReasonCode.TWIN_FIDELITY_FAULT
    assert record.plan is not None  # withheld from apply, kept for review


async def _contradictory_objectives() -> None:
    """A self-contradictory bundle (no in-bounds way to satisfy every objective) is rejected.

    An out-of-*range* target is now pulled to its crop-safe edge and applied (lever 2), so what still
    escalates as a ``constraint_violation`` is an internally inconsistent bundle — here
    ``humidity_low_pct`` above ``humidity_high_pct`` — which clamping deliberately does not repair.
    """
    patch = build_patch(humidity_low_pct=80.0, humidity_high_pct=40.0)
    record = await _run_cycle(chain=fake_chain(build_draft(patch=patch)))
    assert record.outcome.reason_code is ReasonCode.CONSTRAINT_VIOLATION
    assert record.plan is not None


# -- the registries: the spec-08 §2 library, enumerated ---------------------------------------------


@dataclass(frozen=True)
class TwinScenario:
    """A trajectory-shaping scenario rolled through the deterministic twin."""

    id: str
    bullet: str
    run: Callable[[], None]


@dataclass(frozen=True)
class GateScenario:
    """A robustness scenario driven through a full planning cycle."""

    id: str
    bullet: str
    run: Callable[[], Awaitable[None]]


TWIN_SCENARIOS = [
    TwinScenario("steady_state", "steady state", _steady_state),
    TwinScenario("sunrise_sunset_diurnal", "sunrise/sunset diurnal", _sunrise_sunset_diurnal),
    TwinScenario("venting_coupling", "venting coupling", _venting_coupling),
    TwinScenario("misting_coupling", "misting coupling", _misting_coupling),
]

GATE_SCENARIOS = [
    GateScenario("stale_input", "stale input", _stale_input),
    GateScenario("sensor_dropout", "sensor dropout", _sensor_dropout),
    GateScenario("numerical_divergence", "numerical divergence", _numerical_divergence),
    GateScenario("residual_fidelity_fault", "residual / fidelity fault", _residual_fidelity_fault),
    GateScenario("contradictory_objectives", "contradictory objectives", _contradictory_objectives),
]


@pytest.mark.parametrize("scenario", TWIN_SCENARIOS, ids=lambda s: s.id)
def test_golden_twin_scenario(scenario: TwinScenario) -> None:
    scenario.run()


@pytest.mark.parametrize("scenario", GATE_SCENARIOS, ids=lambda s: s.id)
async def test_golden_gate_scenario(scenario: GateScenario) -> None:
    await scenario.run()


def test_golden_near_day_boundary_horizon_extension() -> None:
    """Near-day-boundary horizon extension: 12 h base, doubled to 24 h within reach of a day flip."""
    settings = Settings()
    # 03:00 is 3 h before the 06:00 day_start flip → extended.
    near = choose_horizon(datetime(2026, 6, 17, 3, tzinfo=UTC), SETPOINTS, settings)
    assert near.end - near.start == timedelta(hours=24)
    # 12:00 is 8 h from the nearest boundary (20:00) → the base horizon.
    far = choose_horizon(NOW, SETPOINTS, settings)
    assert far.end - far.start == timedelta(hours=12)
