"""Plan-context serialization — hourly summaries and the hard token budget (P3-PERF-3)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from climate_optimizer.config import Settings
from climate_optimizer.models import Horizon, PlanningContext
from climate_optimizer.planner import (
    ContextBudgetExceededError,
    PlanContextPayload,
    build_plan_context,
    estimate_tokens,
)
from climate_optimizer.twin import PredictedPoint
from conftest import build_context

NOW = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)
HORIZON = Horizon(start=NOW, end=NOW + timedelta(hours=12))


def _forecast(count: int = 3) -> list[PredictedPoint]:
    return [
        PredictedPoint(
            at=NOW + timedelta(hours=i),
            temperature_c=22.0 + i,
            relative_humidity_pct=60.0,
            co2_ppm=1000.0,
            par_umol_m2_s=500.0,
            vpd_kpa=1.0,
            dli_mol_m2_day=5.0,
            soil_moisture_vwc={"bench-a": 0.45},
        )
        for i in range(count)
    ]


def _build(
    ctx: PlanningContext | None = None, settings: Settings | None = None
) -> PlanContextPayload:
    return build_plan_context(
        ctx or build_context(),
        baseline_forecast=_forecast(),
        horizon=HORIZON,
        settings=settings or Settings(),
        now=NOW,
    )


def test_estimate_tokens_is_deterministic_and_scales() -> None:
    assert estimate_tokens("") == 0
    assert estimate_tokens("a" * 400) == 100
    assert estimate_tokens("x" * 8) == estimate_tokens("y" * 8)


def test_payload_carries_the_planner_inputs() -> None:
    payload = _build()

    assert payload.data["greenhouse_id"] == "gh-a"
    assert payload.data["horizon"]["end"] == HORIZON.end.isoformat()
    assert payload.data["current_setpoints"]["temperature_day_c"] == 24.0
    assert payload.data["crop_safe_bounds"]["temperature_day_c"] == {"min": 21.0, "max": 26.0}
    assert len(payload.data["baseline_forecast"]) == 3
    assert payload.data["objectives"]["weights"]["efficiency"] == 0.5
    assert payload.data["objectives"]["time_of_use"][0]["relative_cost"] == 0.7


def test_history_is_serialized_as_hourly_min_mean_max() -> None:
    payload = _build()
    series = next(s for s in payload.data["telemetry_summaries"] if s["metric"] == "temperature")

    assert set(series["buckets"][0]) == {"at", "min", "mean", "max"}
    assert series["buckets"][0]["mean"] == 23.0
    # Raw readings are never sent — only the bucketed aggregate.
    assert "count" not in series["buckets"][0]


def test_absent_bounds_serialize_as_null() -> None:
    ctx = build_context()
    ctx.setpoints.bounds = None
    assert _build(ctx).data["crop_safe_bounds"] is None


def test_empty_buckets_are_dropped_and_empty_series_omitted() -> None:
    from climate_optimizer.models import Metric

    payload = _build(build_context(gap_metric=Metric.CO2))
    metrics = {series["metric"] for series in payload.data["telemetry_summaries"]}

    # Every co2 bucket is a gap, so the series carries no signal and is left out entirely.
    assert "co2" not in metrics
    assert "temperature" in metrics


def test_zone_scoped_series_keep_their_zone_id() -> None:
    payload = _build()
    soil = next(s for s in payload.data["telemetry_summaries"] if s["metric"] == "soil_moisture")
    assert soil["zone_id"] == "bench-a"


def test_payload_text_is_compact_json_matching_the_estimate() -> None:
    payload = _build()

    assert json.loads(payload.text) == payload.data
    assert ", " not in payload.text  # compact separators
    assert payload.token_estimate == estimate_tokens(payload.text)


def test_context_within_budget_is_accepted() -> None:
    payload = _build(settings=Settings(planning={"context_token_budget": 3000}))
    assert payload.token_estimate <= 3000


def test_over_budget_context_raises_instead_of_truncating() -> None:
    settings = Settings(planning={"context_token_budget": 10})

    with pytest.raises(ContextBudgetExceededError) as err:
        _build(settings=settings)

    # No silent truncation: a context that does not fit is an error, not a shorter context.
    assert err.value.budget == 10
    assert err.value.estimated > 10


def test_long_history_can_exceed_the_budget() -> None:
    wide = build_context(hours=2)
    settings = Settings(planning={"context_token_budget": 200})

    with pytest.raises(ContextBudgetExceededError):
        build_plan_context(
            wide,
            baseline_forecast=_forecast(48),
            horizon=HORIZON,
            settings=settings,
            now=NOW,
        )
