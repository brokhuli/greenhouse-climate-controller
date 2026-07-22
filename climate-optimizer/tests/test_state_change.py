"""The state-change gate — when a cycle is worth an LLM call (spec 04 §Invocation strategy)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from climate_optimizer.params import default_twin_params
from climate_optimizer.planner import evaluate_state_change, forecast_distance, hourly_samples
from climate_optimizer.twin import PredictedPoint

NOW = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)
PARAMS = default_twin_params()
THRESHOLD = 0.05


def _series(
    *,
    start: datetime = NOW,
    count: int = 6,
    temperature: float = 22.0,
    humidity: float = 60.0,
    step: float = 0.0,
) -> list[PredictedPoint]:
    return [
        PredictedPoint(
            at=start + timedelta(hours=i),
            temperature_c=temperature + step * i,
            relative_humidity_pct=humidity,
            co2_ppm=1000.0,
            par_umol_m2_s=500.0,
            vpd_kpa=1.0,
            dli_mol_m2_day=5.0,
            soil_moisture_vwc={"bench-a": 0.45},
        )
        for i in range(count)
    ]


def test_hourly_samples_land_on_the_hour() -> None:
    offset = NOW.replace(minute=34)
    samples = hourly_samples(_series(start=offset, count=4))

    assert list(samples) == [
        NOW + timedelta(hours=1),
        NOW + timedelta(hours=2),
        NOW + timedelta(hours=3),
    ]


def test_hourly_samples_interpolate_between_points() -> None:
    # Points at 12:00 (20 °C) and 13:00 (22 °C); the 12:00 sample is exact.
    series = _series(count=2, temperature=20.0, step=2.0)
    samples = hourly_samples(series)
    assert samples[NOW][0] == 20.0


def test_a_series_too_short_to_bracket_yields_no_samples() -> None:
    assert hourly_samples(_series(count=1)) == {}
    assert hourly_samples([]) == {}


def test_identical_forecasts_have_zero_distance() -> None:
    assert forecast_distance(_series(), _series(), PARAMS) == 0.0


def test_distance_grows_with_divergence() -> None:
    near = forecast_distance(_series(temperature=22.0), _series(temperature=22.5), PARAMS)
    far = forecast_distance(_series(temperature=22.0), _series(temperature=40.0), PARAMS)

    assert near is not None and far is not None
    assert far > near > 0


def test_distance_is_averaged_across_the_gated_metrics() -> None:
    # One metric moving a long way is damped by the three that did not — the mean is over all four.
    temperature_only = forecast_distance(
        _series(temperature=22.0), _series(temperature=36.0), PARAMS
    )
    assert temperature_only is not None
    # 14 °C over the 140 °C envelope is 0.1, averaged across four metrics.
    assert temperature_only == pytest.approx(0.025)


def test_non_overlapping_forecasts_have_no_distance() -> None:
    later = _series(start=NOW + timedelta(days=3))
    assert forecast_distance(_series(), later, PARAMS) is None


def test_offset_cadences_still_overlap_on_the_hour_grid() -> None:
    # Consecutive cycles seed 30 min apart; raw timestamps never match, the hour grid does.
    current = _series(start=NOW.replace(minute=4))
    reference = _series(start=NOW.replace(minute=34))

    assert forecast_distance(current, reference, PARAMS) == 0.0


def test_a_settled_greenhouse_suppresses_the_call() -> None:
    decision = evaluate_state_change(
        _series(temperature=22.0),
        _series(temperature=22.01),
        threshold=THRESHOLD,
        params=PARAMS,
    )

    assert decision.suppressed
    assert decision.invoke is False
    assert decision.distance is not None and decision.distance < THRESHOLD


def test_a_moving_greenhouse_invokes_the_planner() -> None:
    decision = evaluate_state_change(
        _series(temperature=22.0, humidity=45.0),
        _series(temperature=40.0, humidity=85.0),
        threshold=THRESHOLD,
        params=PARAMS,
    )

    assert decision.invoke is True
    assert decision.distance is not None and decision.distance >= THRESHOLD


def test_no_reference_skips_the_gate_and_plans_fresh() -> None:
    # The first cycle after a restart has nothing retained to diff against (spec 09).
    decision = evaluate_state_change(_series(), None, threshold=THRESHOLD, params=PARAMS)

    assert decision.invoke is True
    assert decision.distance is None
    assert "no reference forecast" in decision.reason


def test_non_overlapping_reference_skips_the_gate() -> None:
    decision = evaluate_state_change(
        _series(),
        _series(start=NOW + timedelta(days=3)),
        threshold=THRESHOLD,
        params=PARAMS,
    )

    assert decision.invoke is True
    assert "do not overlap" in decision.reason


def test_a_zero_threshold_always_plans() -> None:
    decision = evaluate_state_change(_series(), _series(), threshold=0.0, params=PARAMS)
    assert decision.invoke is True
