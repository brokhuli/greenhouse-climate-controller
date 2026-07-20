"""Digital twin (spec 03) — the deterministic forward climate model.

Given an observed seed and a baseline setpoint trajectory, the twin predicts how temperature,
humidity, CO2, VPD and accumulated DLI evolve over the planning horizon, with the Phase 1
controller *in the loop* (a reduced controller derives actuator levels each sub-step). It is the
controller's coupled first-order-lag model lifted into NumPy, advanced with the **exact analytic
exponential** update ``x(t+Δt) = x_target + (x(t) − x_target)·e^(−Δt/τ)`` in fixed sub-steps under a
zero-order hold — unconditionally stable and reproducible.

Modeling choices where the spec defers to "HAL §5": the envelope-conduction (temperature) and
plant-CO2-uptake (daylight) disturbances are applied as small per-sub-step increments after the
exponential relax; per-zone soil fills toward saturation when its valve is open and otherwise dries
at a constant ET rate to the residual floor. Targets are clipped to the plausibility envelopes so the
physical state never leaves them; because the analytic integrator cannot diverge numerically,
``diverged`` is raised on a **non-finite** step (spec 03 §2).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np
from numpy.typing import NDArray

from .models import Metric, PlanningContext, Setpoints
from .params import TwinParams

# Closed-loop-stability cap on the integration sub-step. The plant's analytic exponential is stable
# at any step, but the reduced controller runs the loop *in the sim* (proportional heat/cool,
# bang-bang misters/CO2), which oscillates when a coarse ZOH step lets the plant fully relax before
# the controller can react. A fine sub-step keeps the closed loop stable and the bang-bang bands
# tight; the config ``solver_max_step_minutes`` is the ceiling, this is the practical bound.
_CONTROL_STEP_CAP_SECONDS = 15.0


def saturation_vapor_pressure_kpa(temperature_c: float) -> float:
    """SVP via the Tetens/Magnus form the controller uses (so twin and controller cannot drift)."""
    return 0.61078 * math.exp(17.27 * temperature_c / (temperature_c + 237.3))


def vapor_pressure_deficit_kpa(temperature_c: float, relative_humidity_pct: float) -> float:
    """VPD derived from temperature and RH."""
    return saturation_vapor_pressure_kpa(temperature_c) * (1.0 - relative_humidity_pct / 100.0)


def rh_target_from_vpd(temperature_c: float, vpd_target_kpa: float) -> float:
    """Invert VPD to the RH target the controller drives humidity toward (unclamped)."""
    svp = saturation_vapor_pressure_kpa(temperature_c)
    if svp <= 0:
        return 0.0
    return 100.0 * (1.0 - vpd_target_kpa / svp)


def second_of_day(moment: datetime) -> int:
    """UTC second-of-day (spec 03 §1.4: every HH:MM is interpreted as UTC-of-day)."""
    return moment.hour * 3600 + moment.minute * 60 + moment.second


def _hhmm_to_sod(hhmm: str) -> int:
    hours, minutes = hhmm.split(":")
    return int(hours) * 3600 + int(minutes) * 60


def solar_fraction(sod: int, params: TwinParams) -> float:
    """Raised half-sine natural-light fraction over [sunrise, sunset); zero at night."""
    if sod < params.sunrise_sod or sod >= params.sunset_sod:
        return 0.0
    span = params.sunset_sod - params.sunrise_sod
    return math.sin(math.pi * (sod - params.sunrise_sod) / span)


def projected_remaining_dli(sod: int, params: TwinParams) -> float:
    """Natural DLI still to come from ``sod`` to sunset (analytic integral of the solar half-sine).

    The twin projects from its bundled ``peak_par`` because the controller-only ``expected_peak_par``
    is not exposed through any optimizer contract (spec 03 §1.3 known gap).
    """
    if sod >= params.sunset_sod:
        return 0.0
    start = max(sod, params.sunrise_sod)
    span = params.sunset_sod - params.sunrise_sod
    theta = math.pi * (start - params.sunrise_sod) / span
    # ∫ sin(pi·(s-sr)/span) ds from start to sunset = span/pi·(cos(theta)+1); PAR µmol·s/m² → mol/m².
    integral_umol_per_m2 = params.peak_par * span / math.pi * (math.cos(theta) + 1.0)
    return integral_umol_per_m2 / 1e6


@dataclass
class TwinState:
    """The mutable simulation state carried across sub-steps."""

    climate: NDArray[np.float64]  # [temperature_c, relative_humidity_pct, co2_ppm, par_umol_m2_s]
    soil: dict[str, float]  # per-zone VWC
    dli_mol: float
    clock: datetime
    day_ordinal: int
    valve_open: dict[str, bool] = field(default_factory=dict)
    last_close_elapsed_s: dict[str, float] = field(default_factory=dict)
    elapsed_s: float = 0.0


@dataclass(frozen=True)
class PredictedPoint:
    """One output point of the predicted-climate trajectory (spec 03 §1.6)."""

    at: datetime
    temperature_c: float
    relative_humidity_pct: float
    co2_ppm: float
    par_umol_m2_s: float
    vpd_kpa: float
    dli_mol_m2_day: float
    soil_moisture_vwc: dict[str, float]


@dataclass(frozen=True)
class TwinResult:
    """The predicted-climate trajectory plus per-run robustness flags."""

    points: list[PredictedPoint]
    diverged: bool = False


def _find_series_mean(ctx: PlanningContext, metric: Metric, zone_id: str | None) -> float:
    """Latest non-empty bucket mean for one metric/scope (the twin's seed value)."""
    for series in ctx.telemetry:
        if series.metric == metric and series.zone_id == zone_id:
            non_empty = [b for b in series.buckets if b.count > 0]
            chosen = max(non_empty or series.buckets, key=lambda b: b.bucket_start, default=None)
            if chosen is not None:
                return chosen.mean
    scope = f" zone {zone_id}" if zone_id else ""
    raise ValueError(f"no telemetry to seed {metric.value}{scope}")


def _rebuild_dli(ctx: PlanningContext, params: TwinParams) -> float:
    """Rebuild accumulated DLI by integrating the PAR history from the day's sunrise to ``to``."""
    interval_seconds = {"1h": 3600.0, "6h": 21600.0, "1d": 86400.0}[ctx.interval.value]
    day_start = ctx.to.replace(hour=0, minute=0, second=0, microsecond=0)
    sunrise = day_start + timedelta(seconds=params.sunrise_sod)
    dli = 0.0
    for series in ctx.telemetry:
        if series.metric != Metric.PAR:
            continue
        for bucket in series.buckets:
            if bucket.count > 0 and sunrise <= bucket.bucket_start < ctx.to:
                dli += bucket.mean * interval_seconds / 1e6
    return dli


def seed_state_from_context(ctx: PlanningContext, params: TwinParams) -> TwinState:
    """Seed the twin from one planning-context read, anchored at the context ``to`` (spec 03 §1.7)."""
    climate = np.array(
        [
            _find_series_mean(ctx, Metric.TEMPERATURE, None),
            _find_series_mean(ctx, Metric.HUMIDITY, None),
            _find_series_mean(ctx, Metric.CO2, None),
            _find_series_mean(ctx, Metric.PAR, None),
        ],
        dtype=np.float64,
    )
    soil = {
        z.zone_id: _find_series_mean(ctx, Metric.SOIL_MOISTURE, z.zone_id)
        for z in ctx.setpoints.targets.zones
    }
    return TwinState(
        climate=climate,
        soil=soil,
        dli_mol=_rebuild_dli(ctx, params),
        clock=ctx.to,
        day_ordinal=ctx.to.toordinal(),
        valve_open=dict.fromkeys(soil, False),
        last_close_elapsed_s=dict.fromkeys(soil, -1e18),
    )


def _is_day(sod: int, setpoints: Setpoints) -> bool:
    return _hhmm_to_sod(setpoints.day_start) <= sod < _hhmm_to_sod(setpoints.day_end)


def _house_levels(
    state: TwinState, setpoints: Setpoints, params: TwinParams, sod: int
) -> NDArray[np.float64]:
    """Reduced controller (spec 03 §1.3): actuator levels the Phase 1 controller would command."""
    temperature, humidity, co2, _par = (float(x) for x in state.climate)
    levels = np.zeros(len(params.gains[0]), dtype=np.float64)

    t_set = (
        setpoints.temperature_day_c if _is_day(sod, setpoints) else setpoints.temperature_night_c
    )
    error = t_set - temperature
    if error > 0:
        levels[params.actuator_index("heater")] = min(max(params.controller_kp * error, 0.0), 100.0)
    elif error < 0:
        cooling = min(max(params.controller_kp * -error, 0.0), 100.0)
        levels[params.actuator_index("fans")] = cooling
        levels[params.actuator_index("roof_vents")] = cooling

    rh_target = rh_target_from_vpd(temperature, setpoints.vpd_target_kpa)
    rh_target = min(max(rh_target, setpoints.humidity_low_pct), setpoints.humidity_high_pct)
    if humidity < rh_target:
        levels[params.actuator_index("misters")] = 100.0

    if _is_day(sod, setpoints):
        projected = state.dli_mol + projected_remaining_dli(sod, params)
        if projected < setpoints.dli_target_mol:
            levels[params.actuator_index("grow_lights")] = 100.0
        if state.dli_mol >= setpoints.dli_target_mol:
            levels[params.actuator_index("shade_screen")] = 100.0

    roof_vents = float(levels[params.actuator_index("roof_vents")])
    if co2 < setpoints.co2_target_ppm and roof_vents <= setpoints.co2_vent_interlock_threshold_pct:
        levels[params.actuator_index("co2_injector")] = 100.0

    return levels


def _update_valves(state: TwinState, setpoints: Setpoints, sod: int) -> None:
    """Per-zone irrigation gating (reduced): open when scheduled, dry, and past the drain gap."""
    for zone in setpoints.zones:
        zid = zone.zone_id
        if zid not in state.soil:
            continue
        soil = state.soil[zid]
        if state.valve_open.get(zid, False):
            if soil >= zone.moisture_high_threshold:
                state.valve_open[zid] = False
                state.last_close_elapsed_s[zid] = state.elapsed_s
        else:
            triggers = [_hhmm_to_sod(t) for t in zone.schedule.split(",")]
            schedule_active = sod >= min(triggers)
            drain_ok = state.elapsed_s - state.last_close_elapsed_s[zid] >= zone.drain_period_secs
            if schedule_active and drain_ok and soil < zone.moisture_low_threshold:
                state.valve_open[zid] = True


def _step(state: TwinState, setpoints: Setpoints, params: TwinParams, dt_seconds: float) -> bool:
    """Advance one sub-step; return True on a non-finite (diverged) step."""
    sod = second_of_day(state.clock)
    _update_valves(state, setpoints, sod)
    levels = _house_levels(state, setpoints, params, sod)

    solar = solar_fraction(sod, params)
    ambient = np.array(
        [
            params.outdoor_temp_c + params.peak_heat_gain_c * solar,
            params.ambient_humidity_pct,
            params.ambient_co2_ppm,
            params.peak_par * solar,
        ],
        dtype=np.float64,
    )
    coupling = params.gains @ (levels / 100.0)
    target = np.clip(ambient + coupling, params.env_min, params.env_max)

    # Carry-over disturbances (spec 03 §1.2) are folded into the *analytic* relaxation rather than
    # added as separate Euler terms, so they stay exact and step-size-independent: envelope
    # conduction is a second first-order pull on temperature toward outdoor (combined rate + shifted
    # steady state), and daylight plant CO2 uptake is a constant draw that shifts the CO2 steady
    # state down by ``uptake·τ``. Both reduce to a single exponential per variable.
    inv_tau = 1.0 / params.tau_seconds
    rate = inv_tau.copy()
    rate[0] += params.heat_loss_coeff
    steady = target.copy()
    steady[0] = (target[0] * inv_tau[0] + params.heat_loss_coeff * params.outdoor_temp_c) / rate[0]
    if solar > 0:
        steady[2] = target[2] - params.plant_co2_uptake_ppm_per_s * params.tau_seconds[2]
    decay = np.exp(-rate * dt_seconds)
    new_climate = np.clip(steady + (state.climate - steady) * decay, params.env_min, params.env_max)

    # Per-zone soil: fill toward saturation when open, else dry to the residual floor.
    soil_decay = math.exp(-dt_seconds / params.soil_tau_seconds)
    for zid, soil in state.soil.items():
        if state.valve_open.get(zid, False):
            updated = params.soil_env_max + (soil - params.soil_env_max) * soil_decay
        else:
            updated = max(
                params.soil_residual_vwc, soil - params.soil_drying_rate_per_s * dt_seconds
            )
        state.soil[zid] = min(max(updated, params.soil_env_min), params.soil_env_max)

    if not np.all(np.isfinite(new_climate)) or not all(
        math.isfinite(v) for v in state.soil.values()
    ):
        return True

    state.climate = new_climate
    state.elapsed_s += dt_seconds
    state.clock = state.clock + timedelta(seconds=dt_seconds)

    new_ordinal = state.clock.toordinal()
    if new_ordinal != state.day_ordinal:  # UTC-midnight DLI reset
        state.dli_mol = 0.0
        state.day_ordinal = new_ordinal
    state.dli_mol += float(new_climate[3]) * dt_seconds / 1e6
    return False


def _point(state: TwinState) -> PredictedPoint:
    temperature, humidity, co2, par = (float(x) for x in state.climate)
    return PredictedPoint(
        at=state.clock,
        temperature_c=temperature,
        relative_humidity_pct=humidity,
        co2_ppm=co2,
        par_umol_m2_s=par,
        vpd_kpa=vapor_pressure_deficit_kpa(temperature, humidity),
        dli_mol_m2_day=state.dli_mol,
        soil_moisture_vwc=dict(state.soil),
    )


def simulate(
    seed: TwinState,
    setpoints: Setpoints,
    *,
    end: datetime,
    params: TwinParams,
    max_step_minutes: float,
    output_interval_minutes: float,
) -> TwinResult:
    """Roll the baseline setpoints forward from ``seed.clock`` to ``end`` (spec 03 §1.6)."""
    state = TwinState(
        climate=seed.climate.copy(),
        soil=dict(seed.soil),
        dli_mol=seed.dli_mol,
        clock=seed.clock,
        day_ordinal=seed.day_ordinal,
        valve_open=dict(seed.valve_open),
        last_close_elapsed_s=dict(seed.last_close_elapsed_s),
        elapsed_s=seed.elapsed_s,
    )

    if not np.all((state.climate >= params.env_min) & (state.climate <= params.env_max)):
        return TwinResult(points=[_point(state)], diverged=True)

    points: list[PredictedPoint] = [_point(state)]
    horizon_seconds = (end - state.clock).total_seconds()
    output_dt = output_interval_minutes * 60.0
    n_blocks = max(1, math.ceil(horizon_seconds / output_dt))
    target_sub = min(max_step_minutes * 60.0, _CONTROL_STEP_CAP_SECONDS)
    n_sub = max(1, math.ceil(output_dt / target_sub))
    sub_dt = output_dt / n_sub

    for _ in range(n_blocks):
        for _ in range(n_sub):
            if _step(state, setpoints, params, sub_dt):
                return TwinResult(points=points, diverged=True)
        points.append(_point(state))

    return TwinResult(points=points, diverged=False)


def fidelity_residual(
    previous_points: list[PredictedPoint],
    observed: dict[Metric, float],
    observed_at: datetime,
    params: TwinParams,
) -> float | None:
    """Normalized one-step-ahead residual (spec 03 §2) — None if ``observed_at`` is off the span.

    ``R = mean(|predicted − observed| / span)`` over temperature/humidity/co2/par (VPD/DLI excluded,
    being derived), each normalized by its plausibility-envelope width so one scale spans all metrics.
    The previous cycle's retained trajectory is linearly interpolated to ``observed_at``.
    """
    if (
        not previous_points
        or observed_at < previous_points[0].at
        or observed_at > previous_points[-1].at
    ):
        return None

    def interp(attr_name: str) -> float:
        for earlier, later in zip(previous_points, previous_points[1:], strict=False):
            if earlier.at <= observed_at <= later.at:
                span = (later.at - earlier.at).total_seconds()
                frac = 0.0 if span == 0 else (observed_at - earlier.at).total_seconds() / span
                a = float(getattr(earlier, attr_name))
                b = float(getattr(later, attr_name))
                return a + (b - a) * frac
        return float(getattr(previous_points[-1], attr_name))

    index = {Metric.TEMPERATURE: 0, Metric.HUMIDITY: 1, Metric.CO2: 2, Metric.PAR: 3}
    attr = {
        Metric.TEMPERATURE: "temperature_c",
        Metric.HUMIDITY: "relative_humidity_pct",
        Metric.CO2: "co2_ppm",
        Metric.PAR: "par_umol_m2_s",
    }
    residuals: list[float] = []
    for metric, obs in observed.items():
        if metric not in index:
            continue
        i = index[metric]
        span = float(params.env_max[i] - params.env_min[i])
        predicted = interp(attr[metric])
        residuals.append(abs(predicted - obs) / span)

    if not residuals:
        return None
    return sum(residuals) / len(residuals)
