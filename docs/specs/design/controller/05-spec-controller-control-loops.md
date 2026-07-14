# Controller — Control Loops & Dynamics

> **Purpose:** Define the controller's decision layer — **stage ③** of the
> [tick pipeline](./02-spec-controller-architecture.md#2-the-tick-pipeline). This is
> the inventory of control loops (what each one reads, the algorithm it runs, the
> actuators it drives), how the active setpoints are resolved each tick, how the
> loops avoid fighting the [coupling](./03-spec-controller-hal-simulation.md#3-coupling-matrix),
> and the **dynamics** they produce over time. All loops consume **trusted**
> readings ([sensing](./04-spec-controller-sensing.md)) and the resolved setpoints;
> their outputs are *desired* actuator states, which [manual override](./02-spec-controller-architecture.md#6-manual-override),
> [safety interlocks](./06-spec-controller-safety-and-constraints.md#2-safety-interlocks),
> and [actuator constraints](./06-spec-controller-safety-and-constraints.md#4-actuator-constraints)
> may still modify before they reach the HAL. Numeric defaults (gains, bands) are
> consolidated in the
> [default-parameters reference](./07-spec-controller-config-and-parameters.md#default-parameters-reference).

---

## The loop hierarchy

A hierarchy of feedback loops operating at different timescales. Separating them by
timescale is what keeps a fast actuator (a heater) from being driven by slow logic
(a watering schedule) and vice versa.

| Tier | Cadence | Loops | Character |
|---|---|---|---|
| **Fast** | seconds–minutes | Temperature PID, humidity hysteresis, CO₂ on/off | Reactive — chase the current reading vs setpoint |
| **Medium** | minutes–hours | Irrigation scheduler (per zone), lighting DLI | Scheduled + adaptive — integrate over time, gated by clock |

Every loop runs every tick (the cadence is how fast its *effect* matters, not how
often it is evaluated). An actuator under an active
[manual override](./02-spec-controller-architecture.md#6-manual-override) still has its
loop evaluated, but the loop's output for that actuator is discarded downstream.

---

## Setpoint resolution

Before the loops run, **stage ②** resolves which setpoints are active this tick.

The **temperature** setpoint switches between `temperature_day_c` and
`temperature_night_c` based on the `day_start` / `day_end` window — a simple
time-of-day lookup, evaluated each tick. This is **not** weather-predictive (that is
[Phase 3](../optimizer/06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application)).
The **humidity** target is **derived here each tick** — not a stored constant — by
inverting the VPD setpoint at the fused temperature and clamping to the humidity safety
bounds (see [the humidity loop](#humidity-hysteresis-band-vpd-feedforward)); because it
tracks the (day/night-varying) temperature it shifts across the day even though
`vpd_target_kpa` itself is constant in Phase 1. CO₂ is constant in Phase 1; the
scheduling mechanism is built to extend to these later. The setpoint values themselves
come from [config](./07-spec-controller-config-and-parameters.md#global-climate-setpoints)
(TOML at startup, runtime edits over REST).

**Clock source.** The time-of-day the window is compared against comes from a single
**injected clock** — a monotonic wall-clock in production, the
[deterministic/virtual clock](./03-spec-controller-hal-simulation.md#7-determinism--seeding)
under a seeded run — never a raw call to system time scattered through the loop. This
keeps day/night resolution **reproducible**: a fixed-seed run flips at the same tick
every time, just like the rest of the pipeline under the
[latched-write model](./02-spec-controller-architecture.md#3-real-time--scheduling-model),
so a scheduling regression shows up as a diff rather than as flake. The `day_start` /
`day_end` window is validated **at config load** (valid `HH:MM`, `day_start < day_end`),
so a malformed window is rejected before the first tick rather than silently flipping
the setpoint — see
[config — day/night scheduling](./07-spec-controller-config-and-parameters.md#daynight-scheduling).
If the clock is ever unreadable at runtime, resolution falls back to the **cooler
`temperature_night_c`** setpoint — the bias least likely to harm the crop — rather than
acting on an ambiguous time.

Because that injected clock advances by `Δt` **per tick**, day/night resolution and every
time-based loop here (DLI accumulation, drain periods, photoperiod) follow *simulated* time, not
wall-clock — so the simulation-only
[time-scale knob](./03-spec-controller-hal-simulation.md#time-scale-speed-without-breaking-determinism)
speeds them all up or down uniformly without changing **which tick** anything flips on. All
durations these loops compare against are counted in ticks (simulated seconds) for exactly this
reason.

---

## Fast loops — reactive

### Temperature PID

Reads the fused air temperature, computes a PID output, and drives the **heater**
(heating mode) or **fans + vents** (cooling mode) proportionally. PID gives a
smooth, proportional response rather than bang-bang switching, which reduces
actuator wear and overshoot against the lagged plant
([HAL §2](./03-spec-controller-hal-simulation.md#2-coupled-first-order-lag)). The sign
of the error selects the mode; the integral term is clamped (anti-windup) so a long
excursion (e.g. while degraded) does not accumulate an unrecoverable correction.

### Humidity hysteresis band (VPD feedforward)

The humidity loop's target is **derived from the VPD setpoint**, not a fixed RH band.
Each tick (during [setpoint resolution](#setpoint-resolution)) it inverts the VPD
target at the fused air temperature to get the RH that would achieve it —
`target_rh = 100 · (1 − vpd_target_kpa / svp(T))`, the air-VPD relation from
[sensing §3](./04-spec-controller-sensing.md#3-derived-sensing--vpd) — then **clamps**
that target to the `[humidity_low_pct, humidity_high_pct]` safety bounds. Fog turns
**on** when RH drops below `clamped_target − humidity_deadband_pct/2` and **off** when
RH rises above `clamped_target + humidity_deadband_pct/2`; the `humidity_deadband_pct`
band prevents rapid on/off cycling (on/off solenoids can only do hysteresis — PID
requires a variable-output actuator).

This makes **VPD — the variable that actually governs transpiration — the control
target**, while temperature stays on its own [PID](#temperature-pid). Because VPD
cannot be actuated directly (only temperature and humidity can), driving the humidity
setpoint *from* VPD is what holds the two loops to a consistent VPD without adding a
second control tier; `humidity_low_pct` / `humidity_high_pct` are demoted to a
**safety envelope** the derived target may never leave.

**Degraded behavior** — two distinct paths
([sensing §3](./04-spec-controller-sensing.md#3-derived-sensing--vpd)): if
**temperature** is unavailable the RH target cannot be derived, so the loop falls back
to the **midpoint of the safety bounds** and keeps running on RH feedback; if the
**humidity** sensor faults there is no feedback to close the loop, so it **fails safe**
(misters off). Either case raises an alarm.

### CO₂ on/off with vent interlock

The injector opens when CO₂ drops below `co2_target_ppm` and closes when it is
reached. A **hard interlock** disables the injector whenever vent position exceeds
`co2_vent_interlock_threshold_pct` — enriching while venting wastes CO₂ immediately.
This is a loop-level interlock (a control optimization), distinct from the
[safety interlocks](./06-spec-controller-safety-and-constraints.md#2-safety-interlocks)
that protect the crop unconditionally.

---

## Medium loops — scheduled & adaptive

### Irrigation scheduler (per zone)

One independent scheduler instance per [zone](./07-spec-controller-config-and-parameters.md#zone-configuration).
A cycle is triggered by **two** conditions together: the zone's time-of-day
`schedule` **and** soil moisture below `moisture_low_threshold`. It irrigates until
`moisture_high_threshold`, then a `drain_period_secs` gap must elapse before another
cycle, to prevent root saturation. Zones are watered independently — a fault or
cycle in one never blocks another.

### Lighting — DLI accumulation

Tracks cumulative PAR over the day (Daily Light Integral, mol/m²/day). Each tick the
loop **projects the natural DLI still to come** before `day_end` from a controller-side
clear-sky model — a raised half-sine of `expected_peak_par` over the day window — and
engages supplemental **grow lights** only when `accumulated + expected_remaining <
dli_target_mol`, i.e. only to cover the shortfall the sun won't provide. So on a bright
day the lights switch off early (or never run), rather than driving the target early and
then having the **shade screen** block the still-abundant sun. The shade screen sheds
excess solar heat/light once the day's target is genuinely met. Lights also extend the
photoperiod for day-length-sensitive crops.

`expected_peak_par` is an **operator estimate**, independent of the simulator's hidden
solar model (the HAL abstraction: the controller cannot see the true disturbance). The
projection is a clear-sky forecast, but it is recomputed each tick against the *measured*
accumulator, so it self-corrects to reality: a dim/cloudy day banks DLI slower than the
model assumes, so the projected total slips below target and the lights re-engage to cover
the genuine shortfall. Setting `expected_peak_par = 0` disables the forecast, reverting to
reactive lighting (on whenever behind during the day window). A faulted PAR sensor falls
back to a time-based photoperiod.

The accumulated DLI (`mol·m⁻²·d⁻¹`) is surfaced as a derived value in the consolidated
[system-state telemetry](./08-spec-controller-interfaces.md#2-mqtt--telemetry-out) — distinct
from the instantaneous `par` sensor reading — so the platform's fleet view can show light as the
day's integral rather than a momentary flux.

---

## Coupling-aware behavior

The loops are written to respect the
[coupling](./03-spec-controller-hal-simulation.md#3-coupling-matrix) rather than fight
it. Three patterns do the work:

- **Shared cooling actuators, one arbiter.** Fans and vents serve the temperature
  PID's cooling mode; the same vents also flush humidity and CO₂. The temperature
  loop owns their position; humidity/CO₂ loops read the resulting state rather than
  commanding vents themselves.
- **VPD drives the humidity setpoint.** The humidity loop targets the RH that realizes
  the VPD setpoint at the current temperature (above), so as the temperature PID moves
  the air the humidity target moves with it instead of fighting a fixed RH band — the
  misters and heater settle to a consistent VPD rather than oscillating against each
  other.
- **The CO₂/vent interlock.** Suppressing enrichment during venting removes the
  classic self-defeating loop (inject while exhausting).

Targeting *variables* rather than actuators
([architecture §5](./02-spec-controller-architecture.md#5-module-composition-rules))
is what lets these patterns live in the loops while the coupling itself stays in the
HAL.

---

## Control dynamics

How the loops behave over time — the controller analogue of interaction behavior:

- **Disturbance response.** A step disturbance (outdoor temperature drop, a vent
  opening) moves the plant along its [τ lag](./03-spec-controller-hal-simulation.md#2-coupled-first-order-lag);
  the PID corrects smoothly, trading a small steady-state settling time for low
  overshoot. Bang-bang loops (humidity, CO₂) ride their deadband.
- **Mode transitions.** Heating ↔ cooling is a sign change on the temperature
  error; the deadband around the setpoint and anti-windup prevent chattering at the
  crossover. Day↔night setpoint changes are step changes the PID absorbs over a few
  τ.
- **Degraded operation.** When a sensor is excluded or a quantity is unavailable
  ([sensing §5](./04-spec-controller-sensing.md#5-the-degradation-ladder)), the
  affected loop suspends or falls back (e.g. lighting → time-based) rather than
  acting on bad data; other loops continue.
- **Override and recovery.** While [overridden](./02-spec-controller-architecture.md#6-manual-override),
  a loop's actuator is held; on override expiry the loop resumes from current
  state, with anti-windup ensuring no accumulated correction is dumped.

---

## Saturation / setpoint-unreachable

A loop can be working perfectly and still fail to reach its setpoint — the actuator is
simply **out of authority**. The heater runs at 100% but the night is colder than the
equipment was sized for; fog is continuously on but ambient is too dry; an outdoor heat
load exceeds full cooling. The control math already handles the *internal* hazard here —
the PID integral is [clamped (anti-windup)](#fast-loops--reactive) so a long saturated
excursion never accumulates an unrecoverable correction. What the loops add is surfacing
the *operational* condition so it isn't silent.

- **Detection.** A loop is saturated when its output is pinned at its min or max limit
  (PID rail, or an on/off actuator held continuously committed) **and** the setpoint error
  persists beyond a configurable window. The window distinguishes a normal transient — a
  step setpoint change the loop is still driving through over a few τ — from a genuine
  inability to reach the target.
- **Condition raised.** Sustained saturation raises `setpoint_unreachable` (a **warning**
  that escalates to **alarm** if it persists), surfaced like every other fault over MQTT
  and REST `/health` ([interfaces](./08-spec-controller-interfaces.md#5-published-shapes--health)).
- **Response: keep controlling.** The loop continues driving at the saturated output — a
  saturated heater is the crop's only heat source and must stay on. This is deliberately the
  **opposite** of the [no-response / stuck](./06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring)
  response, which disables the actuator: a saturated actuator is doing everything it can, so
  the safe action is to alarm and ride the limit, never to cut it out. Safety owns that
  not-disable rule; this section owns detecting the condition from the loop's own state.

The saturation-duration default is in the
[default-parameters reference](./07-spec-controller-config-and-parameters.md#default-parameters-reference).

---

## Tuning

Gains and bands (PID `Kp/Ki/Kd`, hysteresis widths, thresholds) are
TOML-configurable and live in the
[default-parameters reference](./07-spec-controller-config-and-parameters.md#default-parameters-reference).
Because the [simulation is deterministic under a seed](./03-spec-controller-hal-simulation.md#7-determinism--seeding),
a tuning change is evaluated against a reproducible plant response, and a regression
appears as a diff in a fixed-seed run — not as flake. Control-loop and interlock
code carries the highest test coverage in the system (`P1-TEST-1`).

---

## Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| Trusted readings + VPD the loops consume | consumes | [`04-spec-controller-sensing.md`](./04-spec-controller-sensing.md) |
| Plant dynamics the loops act against | acts on | [`03-spec-controller-hal-simulation.md`](./03-spec-controller-hal-simulation.md) |
| Where stage ③ sits + override injection | composed by | [`02-spec-controller-architecture.md`](./02-spec-controller-architecture.md#2-the-tick-pipeline) |
| Unconditional protection over loop output | overruled by | [`06-spec-controller-safety-and-constraints.md`](./06-spec-controller-safety-and-constraints.md) |
| Saturation response (alarm, never disable); stuck/no-response | owned by | [`06-spec-controller-safety-and-constraints.md`](./06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring) |
| Setpoint values + gains/bands + saturation window | configured by | [`07-spec-controller-config-and-parameters.md`](./07-spec-controller-config-and-parameters.md) |
| `P1-TEST-1` (loop/interlock coverage) | cited | [NFR doc](../../artifacts/non-functional-requirements.md) |
