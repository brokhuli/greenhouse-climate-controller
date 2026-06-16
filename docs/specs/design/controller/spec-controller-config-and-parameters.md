# Controller — Configuration & Parameters

> **Purpose:** Define how the controller is configured — the TOML schema loaded at
> startup, what can change at runtime over REST vs what needs a restart, the
> crop-agnostic setpoint principle — and provide the **default-parameters
> reference**, the one place that consolidates every numeric default scattered
> across the other specs (τ, gains, bands, thresholds, bounds, limits, timeouts).
> This is the controller's analogue of a token sheet: the
> [HAL](./spec-controller-hal-simulation.md),
> [sensing](./spec-controller-sensing.md),
> [control loops](./spec-controller-control-loops.md), and
> [safety](./spec-controller-safety-and-constraints.md) specs describe *what* each
> parameter does; this file pins the *values*. The TOML file is the runtime source
> of truth; values here are committed defaults.

---

## Configuration model

Configuration is a **TOML file loaded at startup**. Setpoints and thresholds are
adjustable at runtime via the [REST API](./spec-controller-interfaces.md);
structural changes (adding/removing zones, HAL parameters) require a restart
([startup vs runtime](#startup-vs-runtime)). The same file shape serves both
[deployment modes](./spec-controller-architecture.md#8-deployment).

> **The controller is crop-agnostic.** It knows only numeric setpoints, never a
> crop. The mapping from a crop (and its growth stage) to target values is owned
> *above* the controller: in a multi-greenhouse deployment the Phase 2 platform
> resolves a crop profile into setpoints and applies them over this REST config API
> ([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain));
> running standalone, the values come from this TOML file plus direct REST edits.
> Either way the controller just regulates to the numbers it is given. This is
> restated as a hard rule in
> [constraints](./spec-controller-constraints.md#3-crop-agnostic).

---

## Global climate setpoints

```toml
[setpoints]
temperature_day_c = 24.0
temperature_night_c = 18.0
day_start = "06:00"
day_end = "20:00"
humidity_low_pct = 65.0
humidity_high_pct = 75.0
co2_target_ppm = 1000
co2_vent_interlock_threshold_pct = 15.0
vpd_target_kpa = 1.0
dli_target_mol = 20.0
```

These are the values the [control loops](./spec-controller-control-loops.md)
regulate to. `temperature_day_c` / `temperature_night_c` are selected by
[setpoint resolution](./spec-controller-control-loops.md#setpoint-resolution); the
rest are constant in Phase 1.

## Day/night scheduling

The temperature setpoint switches between day and night values on the
`day_start` / `day_end` window — a time-of-day lookup evaluated each tick. It is
**not** weather-predictive (Phase 3). The mechanism is built to extend to other
setpoints later; see
[setpoint resolution](./spec-controller-control-loops.md#setpoint-resolution).

## Zone configuration

Each irrigation [zone](../physical-system-single.md#zones) is a TOML entry; the
[irrigation scheduler](./spec-controller-control-loops.md#medium-loops--scheduled--adaptive)
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

## Startup vs runtime

| Change | How |
|---|---|
| Setpoint / threshold values | Runtime via REST (`PATCH`) |
| Zone thresholds & schedule | Runtime via REST |
| Manual override | Runtime via REST |
| Adding/removing zones; τ and coupling params | Config file + restart |

The boundary is load-bearing: runtime-mutable state can be edited mid-run without
disturbing the tick ([architecture §3](./spec-controller-architecture.md#3-real-time--scheduling-model)),
while structural change requires a clean restart so the pipeline is rebuilt against
a consistent topology. It is mirrored as a constraint in the
[constraints artifact](../../artifacts/constraints.md) and
[constraints §8](./spec-controller-constraints.md#8-structural-changes-require-a-restart).

---

## Default-parameters reference

Every committed numeric default in one place. These are starting points, all
TOML-configurable; the spec that *uses* each is linked. Tuning is evaluated against
the [deterministic simulation](./spec-controller-hal-simulation.md#7-determinism--seeding).

### HAL simulation ([HAL](./spec-controller-hal-simulation.md))

| Parameter | Default | Unit | Role |
|---|---|---|---|
| `tau_temperature` | 120 | s | Temperature lag time constant |
| `tau_humidity` | 60 | s | Humidity lag time constant |
| `tau_co2` | 30 | s | CO₂ lag time constant |
| Coupling gains | per-effect | — | Strength of each [coupling-matrix](./spec-controller-hal-simulation.md#3-coupling-matrix) effect |
| Disturbance profiles | per-disturbance | — | Outdoor temp, solar/PAR cycle, CO₂ uptake, soil drying, humidity drift |
| Simulation seed | fixed | — | Reproducibility (`P1-TEST-2`) |

### Real-time ([architecture](./spec-controller-architecture.md#3-real-time--scheduling-model))

| Parameter | Default | Unit | NFR |
|---|---|---|---|
| Tick period | 1000 | ms | `P1-PERF-1` |
| Jitter bound | ≤ 50 | ms | `P1-PERF-2` |
| Per-tick compute budget | ≤ 100 | ms | `P1-PERF-3` |

### Sensing & fusion ([sensing](./spec-controller-sensing.md))

| Parameter | Default | Unit | Role |
|---|---|---|---|
| Temperature probe count | 3 | probes | TMR (`P1-REL-2`) |
| Probe disagreement threshold | configurable | °C | Outlier exclusion |
| Stuck-value window | configurable | s | Liveness check (`P1-REL-3`) |
| Humidity plausibility bound | 0–100 | % RH | Out-of-range |
| CO₂ plausibility bound | ~200–5000 | ppm | Out-of-range |
| Soil moisture bound | 0–1 | VWC | Out-of-range |

### Control loops ([control loops](./spec-controller-control-loops.md))

| Parameter | Default | Unit | Role |
|---|---|---|---|
| Temperature PID `Kp/Ki/Kd` | tuned | — | Proportional response + anti-windup |
| Humidity band | `humidity_low_pct`–`humidity_high_pct` | % RH | Hysteresis deadband |
| CO₂ target / vent interlock | `co2_target_ppm` / `co2_vent_interlock_threshold_pct` | ppm / % | On-off + suppression |
| VPD / DLI targets | `vpd_target_kpa` / `dli_target_mol` | kPa / mol·m⁻²·d⁻¹ | Joint + accumulated targets |
| Zone thresholds / drain | per zone | VWC / s | Irrigation gating |

### Safety & actuator constraints ([safety](./spec-controller-safety-and-constraints.md))

| Parameter | Default | Unit | Role |
|---|---|---|---|
| Critical-temperature max | configurable | °C | Interlock trigger (`P1-REL-1`) |
| CO₂ safety ceiling | configurable | ppm | Interlock trigger |
| Vent / shade slew rate | configurable | %/s | Motor limit |
| Heater / injector min on/off | configurable | s | Anti short-cycle |
| Fan ramp-rate | configurable | %/s | Gradual speed change |
| Valve minimum open time | configurable | s | Meaningful delivery |
| Manual-override timeout | configurable | s | Auto-expiry (`P1-RESIL-2`) |

### Actuator health ([safety §5](./spec-controller-safety-and-constraints.md#5-actuator-health-monitoring))

| Parameter | Default | Unit | Role |
|---|---|---|---|
| Commanded-vs-observed tolerance | configurable | % / state | Stuck detection (`P1-REL-4`) |
| No-response detection window | 5 | ticks | No-response detection (`P1-REL-4`) |
| Saturation / `setpoint_unreachable` window | configurable | s | Sustained-saturation alarm |

The per-actuator **fail-safe response** (disable + alarm for stuck/no-response; alarm-only,
keep-controlling for saturation) is owned by
[safety §5](./spec-controller-safety-and-constraints.md#5-actuator-health-monitoring), not a
tunable — these parameters set only *when* each condition fires, not *what* it does.

---

## Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| What τ / coupling / disturbances mean | values for | [`spec-controller-hal-simulation.md`](./spec-controller-hal-simulation.md) |
| What thresholds/bounds mean | values for | [`spec-controller-sensing.md`](./spec-controller-sensing.md) |
| What gains/bands/targets mean | values for | [`spec-controller-control-loops.md`](./spec-controller-control-loops.md) |
| What limits/ceilings mean | values for | [`spec-controller-safety-and-constraints.md`](./spec-controller-safety-and-constraints.md) |
| The REST surface that edits config at runtime | edited via | [`spec-controller-interfaces.md`](./spec-controller-interfaces.md) |
| Crop→setpoint resolution above the controller | defers to | [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain), [platform crop profiles](../platform/spec-platform-crop-profiles.md) |
| `P1-PERF-*`, `P1-REL-*`, `P1-RESIL-2`, `P1-TEST-2` | cited | [NFR doc](../../artifacts/non-functional-requirements.md) |
