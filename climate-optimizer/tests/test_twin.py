"""The twin is deterministic, stays plausible, resets DLI at midnight, and flags divergence."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import numpy as np

from climate_optimizer.models import Metric
from climate_optimizer.params import default_twin_params
from climate_optimizer.twin import (
    PredictedPoint,
    TwinState,
    fidelity_residual,
    seed_state_from_context,
    simulate,
    vapor_pressure_deficit_kpa,
)
from conftest import build_context, build_setpoints

PARAMS = default_twin_params()
_START = datetime(2026, 6, 17, 12, 0, 0, tzinfo=UTC)


def _seed(temperature: float = 20.0, dli: float = 5.0, soil: float = 0.30) -> TwinState:
    return TwinState(
        climate=np.array([temperature, 60.0, 420.0, 700.0]),
        soil={"bench-a": soil},
        dli_mol=dli,
        clock=_START,
        day_ordinal=_START.toordinal(),
        valve_open={"bench-a": False},
        last_close_elapsed_s={"bench-a": -1e18},
    )


def _run(end_hours: int = 12) -> list[PredictedPoint]:
    return simulate(
        _seed(),
        build_setpoints(),
        end=_START + timedelta(hours=end_hours),
        params=PARAMS,
        max_step_minutes=5,
        output_interval_minutes=60,
    ).points


def test_deterministic() -> None:
    a = _run()
    b = _run()
    assert [p.temperature_c for p in a] == [p.temperature_c for p in b]
    assert [p.co2_ppm for p in a] == [p.co2_ppm for p in b]


def test_stays_within_plausibility_envelope() -> None:
    for p in _run(24):
        assert -50.0 <= p.temperature_c <= 90.0
        assert 0.0 <= p.relative_humidity_pct <= 100.0
        assert 0.0 <= p.co2_ppm <= 20000.0
        assert 0.0 <= p.par_umol_m2_s <= 5000.0
        assert 0.0 <= p.soil_moisture_vwc["bench-a"] <= 1.0


def test_vpd_matches_derivation() -> None:
    point = _run()[3]
    expected = vapor_pressure_deficit_kpa(point.temperature_c, point.relative_humidity_pct)
    assert abs(point.vpd_kpa - expected) < 1e-9


def test_dli_resets_at_midnight() -> None:
    points = _run(14)  # 12:00 -> 02:00 next day crosses UTC midnight
    midnight = next(p for p in points if p.at.hour == 0)
    assert midnight.dli_mol_m2_day < 1.0


def test_daytime_tracks_toward_setpoint() -> None:
    # Proportional droop keeps daytime temperature a couple °C below the 24 °C setpoint, not at ambient.
    point = _run()[2]
    assert 20.0 < point.temperature_c < 24.0


def test_diverges_on_out_of_envelope_seed() -> None:
    seed = _seed()
    seed.climate = np.array([500.0, 60.0, 420.0, 700.0])  # temperature past the envelope
    result = simulate(
        seed,
        build_setpoints(),
        end=_START + timedelta(hours=1),
        params=PARAMS,
        max_step_minutes=5,
        output_interval_minutes=60,
    )
    assert result.diverged


def test_seed_from_context() -> None:
    ctx = build_context()
    state = seed_state_from_context(ctx, PARAMS)
    assert state.climate[0] == 23.0  # latest temperature bucket mean
    assert state.soil["bench-a"] == 0.45
    assert state.dli_mol > 0.0  # rebuilt from daytime PAR history


def _points() -> list[PredictedPoint]:
    base = datetime(2026, 6, 17, 12, tzinfo=UTC)
    return [
        PredictedPoint(base, 20.0, 60.0, 400.0, 500.0, 0.9, 5.0, {}),
        PredictedPoint(base + timedelta(hours=1), 24.0, 60.0, 800.0, 500.0, 1.0, 8.0, {}),
    ]


def test_fidelity_residual_computes() -> None:
    at = datetime(2026, 6, 17, 12, 30, tzinfo=UTC)  # midpoint -> predicted T 22.0
    r = fidelity_residual(_points(), {Metric.TEMPERATURE: 22.0}, at, PARAMS)
    assert r is not None
    assert abs(r) < 1e-9  # exact match at the interpolated point


def test_fidelity_residual_off_span_is_none() -> None:
    at = datetime(2026, 6, 17, 20, tzinfo=UTC)  # beyond the trajectory span
    assert fidelity_residual(_points(), {Metric.TEMPERATURE: 22.0}, at, PARAMS) is None
