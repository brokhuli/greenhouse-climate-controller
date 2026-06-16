# Controller — Control Loops & Dynamics

> **Purpose:** Define the controller's decision layer — **stage ③** of the
> [tick pipeline](./spec-controller-architecture.md#2-the-tick-pipeline). This is
> the inventory of control loops (what each one reads, the algorithm it runs, the
> actuators it drives), how the active setpoints are resolved each tick, how the
> loops avoid fighting the [coupling](./spec-controller-hal-simulation.md#3-coupling-matrix),
> and the **dynamics** they produce over time. All loops consume **trusted**
> readings ([sensing](./spec-controller-sensing.md)) and the resolved setpoints;
> their outputs are *desired* actuator states, which [manual override](./spec-controller-architecture.md#6-manual-override),
> [safety interlocks](./spec-controller-safety-and-constraints.md#2-safety-interlocks),
> and [actuator constraints](./spec-controller-safety-and-constraints.md#4-actuator-constraints)
> may still modify before they reach the HAL. Numeric defaults (gains, bands) are
> consolidated in the
> [default-parameters reference](./spec-controller-config-and-parameters.md#default-parameters-reference).

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
[manual override](./spec-controller-architecture.md#6-manual-override) still has its
loop evaluated, but the loop's output for that actuator is discarded downstream.

---

## Setpoint resolution

Before the loops run, **stage ②** resolves which setpoints are active this tick.

The **temperature** setpoint switches between `temperature_day_c` and
`temperature_night_c` based on the `day_start` / `day_end` window — a simple
time-of-day lookup, evaluated each tick. This is **not** weather-predictive (that is
[Phase 3](../spec-climate-optimizer.md#6-setpoint-refinement--application)). Other
setpoints (humidity, CO₂) are constant in Phase 1; the scheduling mechanism is built
to extend to them later. The setpoint values themselves come from
[config](./spec-controller-config-and-parameters.md#global-climate-setpoints) (TOML
at startup, runtime edits over REST).

---

## Fast loops — reactive

### Temperature PID

Reads the fused air temperature, computes a PID output, and drives the **heater**
(heating mode) or **fans + vents** (cooling mode) proportionally. PID gives a
smooth, proportional response rather than bang-bang switching, which reduces
actuator wear and overshoot against the lagged plant
([HAL §2](./spec-controller-hal-simulation.md#2-coupled-first-order-lag)). The sign
of the error selects the mode; the integral term is clamped (anti-windup) so a long
excursion (e.g. while degraded) does not accumulate an unrecoverable correction.

### Humidity hysteresis band

Fog **on** when RH drops below `humidity_low_pct`; fog **off** when RH rises above
`humidity_high_pct`. The deadband prevents rapid on/off cycling. On/off solenoids
can only do hysteresis — PID requires a variable-output actuator. Humidity and
temperature loops **jointly serve the VPD target**: VPD is computed from fused
temperature + RH ([sensing §3](./spec-controller-sensing.md#3-derived-sensing--vpd)),
so neither loop chases its own reading in isolation.

### CO₂ on/off with vent interlock

The injector opens when CO₂ drops below `co2_target_ppm` and closes when it is
reached. A **hard interlock** disables the injector whenever vent position exceeds
`co2_vent_interlock_threshold_pct` — enriching while venting wastes CO₂ immediately.
This is a loop-level interlock (a control optimization), distinct from the
[safety interlocks](./spec-controller-safety-and-constraints.md#2-safety-interlocks)
that protect the crop unconditionally.

---

## Medium loops — scheduled & adaptive

### Irrigation scheduler (per zone)

One independent scheduler instance per [zone](./spec-controller-config-and-parameters.md#zone-configuration).
A cycle is triggered by **two** conditions together: the zone's time-of-day
`schedule` **and** soil moisture below `moisture_low_threshold`. It irrigates until
`moisture_high_threshold`, then a `drain_period_secs` gap must elapse before another
cycle, to prevent root saturation. Zones are watered independently — a fault or
cycle in one never blocks another.

### Lighting — DLI accumulation

Tracks cumulative PAR over the day (Daily Light Integral, mol/m²/day). If the
`dli_target_mol` is not on track by midday, supplemental **grow lights** engage for
the afternoon; the **shade screen** sheds excess solar heat/light. Lights also
extend the photoperiod for day-length-sensitive crops. Because DLI integrates over
the day, the loop is adaptive: a bright morning reduces the afternoon supplement.

---

## Coupling-aware behavior

The loops are written to respect the
[coupling](./spec-controller-hal-simulation.md#3-coupling-matrix) rather than fight
it. Three patterns do the work:

- **Shared cooling actuators, one arbiter.** Fans and vents serve the temperature
  PID's cooling mode; the same vents also flush humidity and CO₂. The temperature
  loop owns their position; humidity/CO₂ loops read the resulting state rather than
  commanding vents themselves.
- **VPD as the joint target.** Treating humidity + temperature as jointly serving
  VPD (above) stops the misters and heater from oscillating against each other.
- **The CO₂/vent interlock.** Suppressing enrichment during venting removes the
  classic self-defeating loop (inject while exhausting).

Targeting *variables* rather than actuators
([architecture §5](./spec-controller-architecture.md#5-module-composition-rules))
is what lets these patterns live in the loops while the coupling itself stays in the
HAL.

---

## Control dynamics

How the loops behave over time — the controller analogue of interaction behavior:

- **Disturbance response.** A step disturbance (outdoor temperature drop, a vent
  opening) moves the plant along its [τ lag](./spec-controller-hal-simulation.md#2-coupled-first-order-lag);
  the PID corrects smoothly, trading a small steady-state settling time for low
  overshoot. Bang-bang loops (humidity, CO₂) ride their deadband.
- **Mode transitions.** Heating ↔ cooling is a sign change on the temperature
  error; the deadband around the setpoint and anti-windup prevent chattering at the
  crossover. Day↔night setpoint changes are step changes the PID absorbs over a few
  τ.
- **Degraded operation.** When a sensor is excluded or a quantity is unavailable
  ([sensing §5](./spec-controller-sensing.md#5-the-degradation-ladder)), the
  affected loop suspends or falls back (e.g. lighting → time-based) rather than
  acting on bad data; other loops continue.
- **Override and recovery.** While [overridden](./spec-controller-architecture.md#6-manual-override),
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
  and REST `/health` ([interfaces](./spec-controller-interfaces.md#5-published-shapes--health)).
- **Response: keep controlling.** The loop continues driving at the saturated output — a
  saturated heater is the crop's only heat source and must stay on. This is deliberately the
  **opposite** of the [no-response / stuck](./spec-controller-safety-and-constraints.md#5-actuator-health-monitoring)
  response, which disables the actuator: a saturated actuator is doing everything it can, so
  the safe action is to alarm and ride the limit, never to cut it out. Safety owns that
  not-disable rule; this section owns detecting the condition from the loop's own state.

The saturation-duration default is in the
[default-parameters reference](./spec-controller-config-and-parameters.md#default-parameters-reference).

---

## Tuning

Gains and bands (PID `Kp/Ki/Kd`, hysteresis widths, thresholds) are
TOML-configurable and live in the
[default-parameters reference](./spec-controller-config-and-parameters.md#default-parameters-reference).
Because the [simulation is deterministic under a seed](./spec-controller-hal-simulation.md#7-determinism--seeding),
a tuning change is evaluated against a reproducible plant response, and a regression
appears as a diff in a fixed-seed run — not as flake. Control-loop and interlock
code carries the highest test coverage in the system (`P1-TEST-1`).

---

## Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| Trusted readings + VPD the loops consume | consumes | [`spec-controller-sensing.md`](./spec-controller-sensing.md) |
| Plant dynamics the loops act against | acts on | [`spec-controller-hal-simulation.md`](./spec-controller-hal-simulation.md) |
| Where stage ③ sits + override injection | composed by | [`spec-controller-architecture.md`](./spec-controller-architecture.md#2-the-tick-pipeline) |
| Unconditional protection over loop output | overruled by | [`spec-controller-safety-and-constraints.md`](./spec-controller-safety-and-constraints.md) |
| Saturation response (alarm, never disable); stuck/no-response | owned by | [`spec-controller-safety-and-constraints.md`](./spec-controller-safety-and-constraints.md#5-actuator-health-monitoring) |
| Setpoint values + gains/bands + saturation window | configured by | [`spec-controller-config-and-parameters.md`](./spec-controller-config-and-parameters.md) |
| `P1-TEST-1` (loop/interlock coverage) | cited | [NFR doc](../../artifacts/non-functional-requirements.md) |
