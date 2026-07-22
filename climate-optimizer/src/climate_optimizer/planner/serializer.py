"""Plan-context serialization (spec 04 §Invocation strategy) — the planner's human turn.

Context preparation happens in Python *before* ``.invoke()``, which keeps the invocation strategy
backend-agnostic (P3-MOD-1). Two levers live here:

* **Hourly telemetry summaries** — history is serialized as the ``(min, mean, max)`` per metric per
  bucket the planning context already carries, never raw readings.
* **Fixed token budget** — the payload is serialized to a fixed budget (default 3000 tokens) and
  **raises** :class:`ContextBudgetExceededError` when it does not fit. There is deliberately **no
  silent truncation**: quietly dropping history would let the planner reason confidently over a
  window it cannot see (P3-PERF-3).

Token counting is a deterministic local estimate rather than a provider tokenizer: the budget is a
guard against unbounded context growth, and it must mean the same thing whichever backend is active
(a provider-specific tokenizer would make the budget drift with the model). The ~4-characters-per-
token ratio is the standard approximation for compact JSON.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..config import Settings
from ..models import Horizon, PlanningContext
from ..twin import PredictedPoint

# Average characters per token for compact JSON — the estimator's single tuning constant.
_CHARS_PER_TOKEN = 4.0

# Float precision in the serialized payload; more digits buy the planner nothing and cost tokens.
_PRECISION = 2


class ContextBudgetExceededError(Exception):
    """The serialized plan context did not fit the configured token budget (spec 04)."""

    def __init__(self, estimated: int, budget: int) -> None:
        super().__init__(
            f"plan context is ~{estimated} tokens, over the {budget}-token budget "
            "(no silent truncation: narrow the window or raise context_token_budget)"
        )
        self.estimated = estimated
        self.budget = budget


def estimate_tokens(text: str) -> int:
    """Deterministic, backend-agnostic token estimate for a serialized context."""
    return math.ceil(len(text) / _CHARS_PER_TOKEN)


@dataclass(frozen=True)
class PlanContextPayload:
    """The serialized human turn plus the budget accounting that produced it."""

    data: dict[str, Any]
    text: str
    token_estimate: int


def _round(value: float) -> float:
    return round(float(value), _PRECISION)


def _telemetry(ctx: PlanningContext) -> list[dict[str, Any]]:
    """Hourly ``(min, mean, max)`` summaries; empty buckets are dropped as they carry no signal."""
    series: list[dict[str, Any]] = []
    for entry in ctx.telemetry:
        buckets = [
            {
                "at": bucket.bucket_start.isoformat(),
                "min": _round(bucket.min),
                "mean": _round(bucket.mean),
                "max": _round(bucket.max),
            }
            for bucket in entry.buckets
            if bucket.count > 0
        ]
        if not buckets:
            continue
        row: dict[str, Any] = {"metric": entry.metric.value, "buckets": buckets}
        if entry.zone_id is not None:
            row["zone_id"] = entry.zone_id
        series.append(row)
    return series


def _forecast(points: list[PredictedPoint]) -> list[dict[str, Any]]:
    """The twin's baseline forward trajectory — what the *current* setpoints are predicted to do."""
    return [
        {
            "at": point.at.isoformat(),
            "temperature_c": _round(point.temperature_c),
            "relative_humidity_pct": _round(point.relative_humidity_pct),
            "co2_ppm": _round(point.co2_ppm),
            "par_umol_m2_s": _round(point.par_umol_m2_s),
            "vpd_kpa": _round(point.vpd_kpa),
            "dli_mol_m2_day": _round(point.dli_mol_m2_day),
        }
        for point in points
    ]


def _actuators(ctx: PlanningContext) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for snapshot in ctx.actuators:
        row: dict[str, Any] = {
            "actuator": snapshot.actuator.value,
            "commanded": _round(snapshot.commanded),
            "health": snapshot.health.value,
        }
        if snapshot.observed is not None:
            row["observed"] = _round(snapshot.observed)
        if snapshot.zone_id is not None:
            row["zone_id"] = snapshot.zone_id
        rows.append(row)
    return rows


def _objectives(settings: Settings) -> dict[str, Any]:
    weights = settings.planning.objective_weights
    return {
        "weights": {
            "anticipation": weights.anticipation,
            "coupling": weights.coupling,
            "efficiency": weights.efficiency,
        },
        "time_of_use": [
            {"start": block.start, "end": block.end, "relative_cost": block.relative_cost}
            for block in settings.cost.time_of_use
        ],
    }


def build_plan_context(
    ctx: PlanningContext,
    *,
    baseline_forecast: list[PredictedPoint],
    horizon: Horizon,
    settings: Settings,
    now: datetime,
) -> PlanContextPayload:
    """Assemble and budget-check the per-cycle plan context.

    Raises :class:`ContextBudgetExceededError` when the payload exceeds
    ``planning.context_token_budget``.
    """
    bounds = ctx.setpoints.bounds
    data: dict[str, Any] = {
        "greenhouse_id": ctx.greenhouse_id,
        "cycle_at": now.isoformat(),
        "horizon": {"start": horizon.start.isoformat(), "end": horizon.end.isoformat()},
        "observed_window": {"from": ctx.from_.isoformat(), "to": ctx.to.isoformat()},
        "current_setpoints": ctx.setpoints.targets.model_dump(mode="json"),
        "setpoints_source": ctx.setpoints.source.value,
        "crop_safe_bounds": (
            bounds.model_dump(mode="json", exclude_none=True) if bounds is not None else None
        ),
        "telemetry_summaries": _telemetry(ctx),
        "actuators": _actuators(ctx),
        "baseline_forecast": _forecast(baseline_forecast),
        "objectives": _objectives(settings),
    }

    text = json.dumps(data, separators=(",", ":"))
    estimate = estimate_tokens(text)
    budget = settings.planning.context_token_budget
    if estimate > budget:
        raise ContextBudgetExceededError(estimate, budget)

    return PlanContextPayload(data=data, text=text, token_estimate=estimate)
