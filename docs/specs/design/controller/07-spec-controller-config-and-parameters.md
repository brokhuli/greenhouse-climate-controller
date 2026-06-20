# Controller — Configuration & Parameters

> **Purpose:** Define how the controller is configured — the TOML schema loaded at
> startup, what can change at runtime over REST vs what needs a restart, the
> crop-agnostic setpoint principle — and provide the **default-parameters
> reference**, the one place that consolidates every numeric default scattered
> across the other specs (τ, gains, bands, thresholds, bounds, limits, timeouts).
> This is the controller's analogue of a token sheet: the
> [HAL](./03-spec-controller-hal-simulation.md),
> [sensing](./04-spec-controller-sensing.md),
> [control loops](./05-spec-controller-control-loops.md), and
> [safety](./06-spec-controller-safety-and-constraints.md) specs describe *what* each
> parameter does; this file pins the *values*. The TOML file is the runtime source
> of truth; values here are committed defaults.

---

## Configuration model

Configuration is a **TOML file loaded at startup**. Setpoints and thresholds are
adjustable at runtime via the [REST API](./08-spec-controller-interfaces.md);
structural changes (adding/removing zones, HAL parameters) require a restart
([startup vs runtime](#startup-vs-runtime)). The same file shape serves both
[deployment modes](./02-spec-controller-architecture.md#8-deployment).

> **The controller is crop-agnostic.** It knows only numeric setpoints, never a
> crop. The mapping from a crop (and its growth stage) to target values is owned
> *above* the controller: in a multi-greenhouse deployment the Phase 2 platform
> resolves a crop profile into setpoints and applies them over this REST config API
> ([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain));
> running standalone, the values come from this TOML file plus direct REST edits.
> Either way the controller just regulates to the numbers it is given. This is
> restated as a hard rule in
> [constraints](./10-spec-controller-constraints.md#3-crop-agnostic).

---

## Global climate setpoints

```toml
[setpoints]
temperature_day_c = 24.0
temperature_night_c = 18.0
day_start = "06:00"
day_end = "20:00"
humidity_low_pct = 50.0     # safety clamp floor for the VPD-derived RH target
humidity_high_pct = 85.0    # safety clamp ceiling for the VPD-derived RH target
humidity_deadband_pct = 5.0 # full hysteresis band width around the derived RH target
co2_target_ppm = 1000
co2_vent_interlock_threshold_pct = 15.0
vpd_target_kpa = 1.0        # primary humidity control input (drives the RH target each tick)
dli_target_mol = 20.0
```

These are the values the [control loops](./05-spec-controller-control-loops.md)
regulate to. `temperature_day_c` / `temperature_night_c` are selected by
[setpoint resolution](./05-spec-controller-control-loops.md#setpoint-resolution). The
**humidity** target is *not* stored: it is derived each tick by inverting
`vpd_target_kpa` at the fused temperature and clamping to
`[humidity_low_pct, humidity_high_pct]` (the [humidity loop](./05-spec-controller-control-loops.md#humidity-hysteresis-band-vpd-feedforward)),
so it tracks temperature even though `vpd_target_kpa` is constant in Phase 1. The
remaining setpoints are constant in Phase 1.

## Day/night scheduling

The temperature setpoint switches between day and night values on the
`day_start` / `day_end` window — a time-of-day lookup evaluated each tick against an
[injected clock](./05-spec-controller-control-loops.md#setpoint-resolution) (so the flip
is reproducible under a seed). It is **not** weather-predictive (Phase 3). The
mechanism is built to extend to other setpoints later; see
[setpoint resolution](./05-spec-controller-control-loops.md#setpoint-resolution).

The window is **validated at config load**, through the same `serde` + `toml` boundary
that validates every other parameter ([tech stack](./09-spec-controller-tech-stack.md#configuration)):
`day_start` and `day_end` must be valid `HH:MM` and satisfy `day_start < day_end`. A
malformed or inverted window is rejected at startup — naming the violated bound, the
same way an out-of-range REST edit is rejected — rather than silently selecting the
wrong setpoint mid-run. This is the day/night counterpart of "a bad config fails at
load, not mid-tick."

## Zone configuration

Each irrigation [zone](../physical-system-single.md#zones) is a TOML entry; the
[irrigation scheduler](./05-spec-controller-control-loops.md#medium-loops--scheduled--adaptive)
runs one independent loop per zone.

```toml
[[zones]]
id = "bench-a"
moisture_low_threshold = 0.35   # VWC — irrigation triggers below this
moisture_high_threshold = 0.55  # VWC — irrigation stops above this
drain_period_secs = 300         # minimum gap between cycles
schedule = "06:00,14:00"        # time-of-day triggers

[[zones]]
id = "seedling-tray"
moisture_low_threshold = 0.50
moisture_high_threshold = 0.70
drain_period_secs = 600
schedule = "07:00,13:00,18:00"
```

## Simulation control (simulated HAL only)

```toml
[simulation]
time_scale = 1.0   # wall-clock tick-cadence multiplier; 1.0 = real-time
```

`time_scale` sets how fast the simulated clock runs relative to wall-clock by scaling **only** the
tick cadence (`sleep = tick_period / time_scale`); it does **not** change the per-tick simulation
step `Δt`, so determinism is preserved
([HAL §7](./03-spec-controller-hal-simulation.md#time-scale-speed-without-breaking-determinism)).
It is a **simulated-HAL-only** knob — a real-hardware backend has no such concept — and is also
**runtime-adjustable** over the sim-only
[REST surface](./08-spec-controller-interfaces.md#simulation-control-simulated-hal-only). The value
is **ephemeral**: this TOML `time_scale` is the **reset-on-restart default**, not persisted live
state, so a restart returns to it (typically 1×) regardless of any runtime change — the same
ephemerality as a manual override or a sensor injection. Accepted range **0.25–8×** (canonical
stops 0.5/1/2/4); the 8× ceiling keeps the wall interval above the per-tick compute budget
(`P1-PERF-3`). Each controller has its **own** `time_scale`; there is no shared/master clock across
greenhouses.

> **Duration semantics — simulated seconds, not wall-clock.** Every in-simulation duration in this
> file and the reference below — `drain_period_secs`, `sensor_injection_timeout_secs`, the
> manual-override timeout, the saturation and no-response windows, `interlock_min_hold` — is counted
> in **simulated** time (ticks; one tick = one simulated second at the canonical `Δt`). They
> therefore **scale with `time_scale`** automatically: a `drain_period_secs = 300` elapses in 300
> simulated seconds always, which is 150 wall-clock seconds at 2×. Only genuinely wall-clock
> **infrastructure** timers — MQTT reconnect backoff, REST/HTTP timeouts — stay on wall-clock and do
> **not** scale. (`_secs` names are kept for readability; they mean simulated seconds.)

## Startup vs runtime

| Change | How |
|---|---|
| Setpoint / threshold values | Runtime via REST (`PATCH`) |
| Zone thresholds & schedule | Runtime via REST |
| Manual override | Runtime via REST |
| Sensor injection (simulated HAL only) | Runtime via REST — simulation builds only ([HAL §9](./03-spec-controller-hal-simulation.md#9-sensor-reading-injection)) |
| Time-scale / speed (simulated HAL only) | Runtime via REST — simulation builds only; ephemeral, resets to the TOML default on restart ([HAL §7](./03-spec-controller-hal-simulation.md#time-scale-speed-without-breaking-determinism)) |
| Adding/removing zones; τ and coupling params | Config file + restart |

The boundary is load-bearing: runtime-mutable state can be edited mid-run without
disturbing the tick ([architecture §3](./02-spec-controller-architecture.md#3-real-time--scheduling-model)),
while structural change requires a clean restart so the pipeline is rebuilt against
a consistent topology. It is mirrored as a constraint in the
[constraints artifact](../../artifacts/constraints.md) and
[constraints §8](./10-spec-controller-constraints.md#8-structural-changes-require-a-restart).

---

## Default-parameters reference

Every committed numeric default in one place. These are starting points, all
TOML-configurable; the spec that *uses* each is linked. Tuning is evaluated against
the [deterministic simulation](./03-spec-controller-hal-simulation.md#7-determinism--seeding).

### HAL simulation ([HAL](./03-spec-controller-hal-simulation.md))

| Parameter | Default | Unit | Role |
|---|---|---|---|
| `tau_temperature` | 120 | s | Temperature lag time constant |
| `tau_humidity` | 60 | s | Humidity lag time constant |
| `tau_co2` | 30 | s | CO₂ lag time constant |
| Coupling gains | per-effect | — | Strength of each [coupling-matrix](./03-spec-controller-hal-simulation.md#3-coupling-matrix) effect |
| Disturbance profiles | per-disturbance | — | Outdoor temp, solar/PAR cycle, CO₂ uptake, soil drying, humidity drift |
| Simulation seed | fixed | — | Reproducibility (`P1-TEST-2`) |
| `sensor_injection_timeout_secs` | 300 | s (sim) | Default auto-expiry for a [sensor-reading injection](./03-spec-controller-hal-simulation.md#9-sensor-reading-injection) (sim-only); per-request `ttl_secs` overrides it |
| `time_scale` | 1.0 | × (0.25–8) | Wall-clock tick-cadence multiplier (sim-only); runtime-adjustable, ephemeral, per-controller ([HAL §7](./03-spec-controller-hal-simulation.md#time-scale-speed-without-breaking-determinism)) |

### Real-time ([architecture](./02-spec-controller-architecture.md#3-real-time--scheduling-model))

| Parameter | Default | Unit | NFR |
|---|---|---|---|
| Tick period | 1000 | ms | `P1-PERF-1` |
| Jitter bound | ≤ 50 | ms | `P1-PERF-2` |
| Per-tick compute budget | ≤ 100 | ms | `P1-PERF-3` |

Tick period and jitter are the **1× baseline**. On the simulated HAL the
[`time_scale`](#simulation-control-simulated-hal-only) knob scales the wall-clock period to
`1000 / time_scale` ms; the per-tick compute budget (`P1-PERF-3`) is unchanged, which is what bounds
the maximum usable speed.

### Sensing & fusion ([sensing](./04-spec-controller-sensing.md))

| Parameter | Default | Unit | Role |
|---|---|---|---|
| Temperature probe count | 3 | probes | TMR (`P1-REL-2`) |
| Probe disagreement threshold | configurable (e.g. 2.0) | °C | Outlier exclusion |
| Stuck-value window | configurable (e.g. 5) | s | Liveness check (`P1-REL-3`) |
| Humidity plausibility bound | 0–100 | % RH | Out-of-range |
| CO₂ plausibility bound | ~200–5000 | ppm | Out-of-range |
| Soil moisture bound | 0–1 | VWC | Out-of-range |

### Control loops ([control loops](./05-spec-controller-control-loops.md))

| Parameter | Default | Unit | Role |
|---|---|---|---|
| Temperature PID `Kp/Ki/Kd` | tuned | — | Proportional response + anti-windup |
| Humidity safety bounds | `humidity_low_pct`–`humidity_high_pct` | % RH | Clamp the VPD-derived RH target |
| Humidity deadband | `humidity_deadband_pct` | % RH | Hysteresis width around the derived RH target |
| CO₂ target / vent interlock | `co2_target_ppm` / `co2_vent_interlock_threshold_pct` | ppm / % | On-off + suppression |
| VPD target | `vpd_target_kpa` | kPa | **Primary humidity control input** — derives the RH target each tick |
| DLI target | `dli_target_mol` | mol·m⁻²·d⁻¹ | Accumulated lighting target |
| Zone thresholds / drain | per zone | VWC / s | Irrigation gating |

### Safety & actuator constraints ([safety](./06-spec-controller-safety-and-constraints.md))

| Parameter | Default | Unit | Role |
|---|---|---|---|
| Critical-temperature max | configurable (e.g. 40) | °C | Interlock trigger (`P1-REL-1`) |
| CO₂ safety ceiling | configurable (e.g. 5000) | ppm | Interlock trigger |
| `interlock_rearm_hysteresis` | configurable (e.g. 2 / 200) | °C / ppm | Margin a reading must recover past before an interlock clears ([safety §2](./06-spec-controller-safety-and-constraints.md#assert-and-clear-re-arm-hysteresis)) |
| `interlock_min_hold` | configurable (e.g. 60) | s | Minimum dwell an interlock stays asserted before it may clear ([safety §2](./06-spec-controller-safety-and-constraints.md#assert-and-clear-re-arm-hysteresis)) |
| Vent / shade slew rate | configurable (e.g. 2) | %/s | Motor limit |
| Heater / injector min on/off | configurable (e.g. 120 / 120) | s | Anti short-cycle |
| Fan ramp-rate | configurable (e.g. 10) | %/s | Gradual speed change |
| Valve minimum open time | configurable (e.g. 30) | s | Meaningful delivery |
| Manual-override timeout | configurable (e.g. 1800) | s | Auto-expiry (`P1-RESIL-2`) |

### Actuator health ([safety §5](./06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring))

| Parameter | Default | Unit | Role |
|---|---|---|---|
| Commanded-vs-observed tolerance | configurable (e.g. 5 / state mismatch) | % / state | Stuck detection (`P1-REL-4`) |
| No-response detection window | 5 | ticks | No-response detection (`P1-REL-4`) |
| Saturation / `setpoint_unreachable` window | configurable (e.g. 300) | s | Sustained-saturation alarm |

The per-actuator **fail-safe response** (disable + alarm for stuck/no-response; alarm-only,
keep-controlling for saturation) is owned by
[safety §5](./06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring), not a
tunable — these parameters set only *when* each condition fires, not *what* it does.

---

## Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| What τ / coupling / disturbances mean | values for | [`03-spec-controller-hal-simulation.md`](./03-spec-controller-hal-simulation.md) |
| What thresholds/bounds mean | values for | [`04-spec-controller-sensing.md`](./04-spec-controller-sensing.md) |
| What gains/bands/targets mean | values for | [`05-spec-controller-control-loops.md`](./05-spec-controller-control-loops.md) |
| What limits/ceilings mean | values for | [`06-spec-controller-safety-and-constraints.md`](./06-spec-controller-safety-and-constraints.md) |
| The REST surface that edits config at runtime | edited via | [`08-spec-controller-interfaces.md`](./08-spec-controller-interfaces.md) |
| Crop→setpoint resolution above the controller | defers to | [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain), [platform crop profiles](../platform/05-spec-platform-crop-profiles.md) |
| `P1-PERF-*`, `P1-REL-*`, `P1-RESIL-2`, `P1-TEST-2` | cited | [NFR doc](../../artifacts/non-functional-requirements.md) |
