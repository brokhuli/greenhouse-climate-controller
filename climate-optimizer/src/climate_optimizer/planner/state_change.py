"""The state-change gate (spec 04 §Invocation strategy) — should this cycle call the LLM at all?

The gate compares the twin's **predicted-climate forecast** for this cycle against the *reference
forecast* — the one retained from the last cycle that actually ran the planner — and suppresses the
call when the greenhouse is heading somewhere close enough to where it was already heading. It is
measured exactly like the twin's fidelity residual (spec 03 §2): per required metric, at each shared
hourly point, ``r = |current − reference| / span`` normalized by the metric's plausibility-envelope
width, with the gate's distance ``D = mean(r)`` over those metrics and points.

Two distinctions matter and are easy to conflate:

* The reference is a twin **climate** series, never ``OptimizerPlan.trajectory`` (a *setpoint*
  series). The two are kept apart deliberately.
* When the forecasts do not overlap — the first cycle after a restart, when both are in-memory only
  and none was retained — the gate is **skipped** and the planner runs to rebuild the baseline
  (spec 09 §Stateless restart). No overlap means no evidence of stability, not evidence of it.

Both series are first resampled onto a **shared hour-aligned grid**. Each cycle seeds the twin at
that read's ``to`` instant, so consecutive cycles produce hourly points offset by the cadence (12:04,
13:04, … then 12:34, 13:34, …) which share no wall-clock timestamps at all. Interpolating both onto
the top of each hour is what gives the "overlapping window" real points to compare.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from ..params import TwinParams
from ..twin import PredictedPoint

# The metrics the gate measures, paired with their row index in the twin's envelope vectors.
# Derived VPD/DLI are excluded — they are functions of these, so including them would double-count.
_GATED_METRICS: tuple[tuple[str, int], ...] = (
    ("temperature_c", 0),
    ("relative_humidity_pct", 1),
    ("co2_ppm", 2),
    ("par_umol_m2_s", 3),
)


@dataclass(frozen=True)
class StateChangeDecision:
    """Whether to invoke the planner, and the distance that decided it."""

    invoke: bool
    distance: float | None
    reason: str

    @property
    def suppressed(self) -> bool:
        return not self.invoke


Sample = tuple[float, ...]


def _lerp(earlier: PredictedPoint, later: PredictedPoint, at: datetime) -> Sample:
    span = (later.at - earlier.at).total_seconds()
    frac = 0.0 if span == 0 else (at - earlier.at).total_seconds() / span
    return tuple(
        getattr(earlier, attr) + (getattr(later, attr) - getattr(earlier, attr)) * frac
        for attr, _ in _GATED_METRICS
    )


def hourly_samples(points: list[PredictedPoint]) -> dict[datetime, Sample]:
    """Interpolate the gated metrics onto the hour-aligned instants inside the series' span."""
    if len(points) < 2:
        return {}

    start, end = points[0].at, points[-1].at
    cursor = start.replace(minute=0, second=0, microsecond=0)
    if cursor < start:
        cursor += timedelta(hours=1)

    samples: dict[datetime, Sample] = {}
    index = 0
    while cursor <= end:
        while index + 2 < len(points) and points[index + 1].at < cursor:
            index += 1
        samples[cursor] = _lerp(points[index], points[index + 1], cursor)
        cursor += timedelta(hours=1)
    return samples


def forecast_distance(
    current: list[PredictedPoint],
    reference: list[PredictedPoint],
    params: TwinParams,
) -> float | None:
    """``D = mean(|current − reference| / span)`` over shared points; ``None`` without overlap."""
    current_samples = hourly_samples(current)
    reference_samples = hourly_samples(reference)

    residuals: list[float] = []
    for at, sample in current_samples.items():
        other = reference_samples.get(at)
        if other is None:
            continue
        for position, (_attr, index) in enumerate(_GATED_METRICS):
            span = float(params.env_max[index] - params.env_min[index])
            if span <= 0:
                continue
            residuals.append(abs(sample[position] - other[position]) / span)

    if not residuals:
        return None
    return sum(residuals) / len(residuals)


def evaluate_state_change(
    current: list[PredictedPoint],
    reference: list[PredictedPoint] | None,
    *,
    threshold: float,
    params: TwinParams,
) -> StateChangeDecision:
    """Decide whether this cycle calls the planner (spec 04).

    Suppression means the cycle is **extended**: no LLM call and no write — the last applied bundle
    stays in force and the retained trajectory is surfaced, never replayed.
    """
    if not reference:
        return StateChangeDecision(True, None, "no reference forecast retained; planning fresh")

    distance = forecast_distance(current, reference, params)
    if distance is None:
        return StateChangeDecision(True, None, "forecasts do not overlap; planning fresh")

    if distance < threshold:
        return StateChangeDecision(
            False,
            distance,
            f"predicted climate moved {distance:.4f} < {threshold} since the last planned cycle",
        )
    return StateChangeDecision(
        True, distance, f"predicted climate moved {distance:.4f} >= {threshold}"
    )
