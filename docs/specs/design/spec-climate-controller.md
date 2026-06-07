# Phase 1 — Greenhouse Climate Controller (Spec)

Architectural specification for the Phase 1 controller: how it senses the greenhouse, decides, and
acts. This describes the **software**. For the physical system it controls — the sensors, actuators,
and the coupling between climate variables — see
[`physical-system-single.md`](./physical-system-single.md).

> Scope note: this is an architectural spec (components, responsibilities, behavior, configuration).
> Concrete code/module/struct design is deferred until implementation.

---

## 1. Overview

Phase 1 is a **deterministic, real-time control loop** for a single simulated greenhouse. It runs a
Rust controller that reads simulated sensors, fuses and conditions those readings, runs a hierarchy
of control loops against configurable setpoints, enforces safety interlocks, and drives simulated
actuators — all behind a Hardware Abstraction Layer (HAL). It exposes its state and configuration
over MQTT, a REST API, and WebSockets.

What is being sensed and actuated (the physical inventory) lives in
[`physical-system-single.md`](./physical-system-single.md); this spec covers how the controller uses them.

---

## 2. Architecture

The controller is a pipeline that runs on a fixed tick:

```
HAL (simulated sensors)
      │  raw readings
      ▼
Sensor Fusion + Fault Detection      ← conditions readings into trusted values
      │  trusted state
      ▼
Setpoint Resolution                  ← resolves active setpoints (e.g. day vs night)
      │
      ▼
Control Loops (fast + medium)        ← compute desired actuator outputs
      │  desired outputs
      ▼
Safety Interlocks                    ← can override any output (unconditional)
      │
      ▼
Actuator Constraints                 ← rate limits / min cycle times
      │  commanded outputs
      ▼
HAL (simulated actuators)
```

External surface (MQTT / REST / WebSockets) observes and configures the controller; **manual
override** injects forced actuator states downstream of the control loops but still upstream of
safety interlocks.

| Component | Responsibility |
|---|---|
| HAL | Simulate sensors and actuators; produce realistic, coupled, lagged dynamics |
| Sensor Fusion | Combine redundant temperature probes into one trusted value |
| Fault Detection | Detect stuck / out-of-range sensors; apply fail-safe responses |
| Setpoint Resolution | Pick the currently active setpoints (day/night schedule) |
| Control Loops | Compute desired actuator states from trusted readings + setpoints |
| Safety Interlocks | Unconditionally override outputs on dangerous conditions |
| Actuator Constraints | Enforce hardware limits (slew rate, min on/off time) |
| Interfaces | MQTT / REST / WebSockets for telemetry, config, and control |

---

## 3. HAL — Simulation Model

The HAL replaces real hardware with a software simulation. Its fidelity is deliberately bounded:
**coupled first-order lag**, not a full physics model. Rich heat/mass-balance simulation is reserved
for Phase 3's digital twin.

### Coupled first-order lag

Each simulated state variable (temperature, humidity, CO₂, PAR, per-zone soil moisture) moves toward
a target value at a rate set by a per-variable time constant **τ**. The target is shifted by active
actuators and by hidden disturbances. This gives realistic gradual response — a heater turning on
warms the air over time, not instantly — which makes the control loops non-trivial to tune.

Example default time constants (configurable in TOML):

| Variable | τ (default) | Rationale |
|---|---|---|
| Temperature | 120 s | Air mass takes minutes to respond to heat input |
| Humidity | 60 s | Moisture responds faster than bulk temperature |
| CO₂ | 30 s | Injection/venting changes concentration quickly |

### Coupling matrix

Actuators affect multiple variables at once — this is what makes the controller experience the
[coupling problem](./physical-system-single.md#the-coupling-problem) rather than treating it as theoretical:

| Actuator | Effects on simulated state |
|---|---|
| Heater | temperature ↑ |
| Fans | temperature → outdoor, humidity ↓, CO₂ → ambient |
| Roof vents | temperature → outdoor, humidity → ambient, CO₂ → ambient (~420 ppm) |
| Misters / foggers | humidity ↑, temperature ↓ (evaporative) |
| CO₂ injector | CO₂ ↑ (modeled as clean injection; a combustion variant would also add heat + humidity) |
| Grow lights | PAR ↑, temperature ↑ (waste heat) |
| Shade screen | PAR ↓, reduces incoming solar heat gain (temperature effect) |
| Irrigation valve (per zone) | soil moisture ↑ (that zone) |

### Hidden disturbance model

The simulation maintains internal state the controller **cannot** see — it only ever reads sensor
outputs. These disturbances create the load the controller must fight:

- **Outdoor temperature** — static value or a daily profile; drives heat loss/gain.
- **Solar / PAR day cycle** — natural light by time of day; drives natural PAR (so grow lights
  supplement) and solar heat gain.
- **Plant CO₂ uptake** — consumes CO₂ during light hours.
- **Per-zone soil drying** — soil moisture decays over time.
- **Ambient humidity drift** and a **heat-loss coefficient** to the outside.

> **Boundary:** the controller sees only sensor readings; simulation internals and disturbances are
> hidden. This keeps the HAL swappable for real hardware later and preserves a clean control/plant
> separation. Full physics (heat capacity, mass transfer) is intentionally **out of scope** for
> Phase 1 — see [§12](#12-scope--deferred-controller-capabilities).

All simulation parameters (time constants, coupling gains, disturbance profiles) are configurable in
TOML.

---

## 4. Configuration & Setpoints

Configuration is a TOML file loaded at startup. Setpoints and thresholds are adjustable at runtime
via the REST API; structural changes (adding/removing zones) require a restart.

> **The controller is crop-agnostic.** It knows only these numeric setpoints, never a crop. The
> mapping from a crop (and its growth stage) to target values is owned *above* the controller: in a
> multi-greenhouse deployment the Phase 2 platform resolves a crop profile into setpoints and applies
> them over this REST config API (the runtime `PATCH` path below); running standalone, the values
> come from the TOML file plus direct REST edits. Either way the controller just regulates to the
> numbers it is given.

### Global climate setpoints

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

### Day/night setpoint scheduling

The **temperature** setpoint switches between `temperature_day_c` and `temperature_night_c` based on
the `day_start` / `day_end` window — a simple time-of-day lookup, evaluated each tick by setpoint
resolution. This is **not** weather-predictive (that is Phase 3). Other setpoints (humidity, CO₂)
are constant in Phase 1; the scheduling mechanism is built to extend to them later.

### Zone configuration

Each irrigation [zone](./physical-system-single.md#zones) is a TOML entry. The irrigation scheduler runs
one independent loop per zone.

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

### Startup vs runtime

| Change | How |
|---|---|
| Setpoint / threshold values | Runtime via REST (`PATCH`) |
| Zone thresholds & schedule | Runtime via REST |
| Manual override | Runtime via REST |
| Adding/removing zones; τ and coupling params | Config file + restart |

---

## 5. Sensor Fusion — Redundant Temperature with Voting

Temperature is measured by **three co-located probes** rather than one. A voting/fusion step
combines them into a single trusted value before the temperature PID and VPD calculation consume it:

- **Median voting** — the fused value is the median of the readings, which rejects a single outlier
  (a probe reading wildly high or low) without any tuning. Implemented as a median over the readings
  slice, so the probe count is not hardcoded; **3 is the default (Triple Modular Redundancy)** — the
  minimum that delivers single-fault *correction*, not just detection.
- **Disagreement detection** — if one probe deviates from the median by more than a threshold, it is
  flagged faulty and excluded; the system continues on the remaining two (degraded but operational).
- **Loss of redundancy** — with only one trustworthy probe left, raise an alarm (no further fault
  tolerance) but keep controlling.
- **Total disagreement** — if no two probes agree, treat temperature as unavailable and trigger the
  safety interlock rather than acting on an untrusted value.

This is *competitive (redundant) fusion*: multiple sensors of the same quantity combined for fault
tolerance. It is distinct from the derived sensing that produces VPD (a deterministic formula) and
from single-sensor outlier filtering. Only temperature is made redundant in Phase 1 — it drives the
most actuators, so a bad temperature reading is the most dangerous single fault. Other sensors are
covered by [fault detection](#8-sensor-fault-detection-non-temperature-sensors) instead.

---

## 6. Control Loops

A hierarchy of feedback loops operating at different timescales. All consume **trusted** readings
(post-fusion, post-fault-detection) and the currently resolved setpoints.

### Fast Loops — Reactive (seconds to minutes)

**Temperature PID**
Reads the fused air temperature → computes PID output → drives heater (heating mode) or fans + vents
(cooling mode) proportionally. PID gives a smooth, proportional response rather than bang-bang
switching, which reduces actuator wear and overshoot.

**Humidity hysteresis band**
Fog on when RH drops below `humidity_low_pct`; fog off when RH rises above `humidity_high_pct`. The
deadband prevents rapid on/off cycling. On/off solenoids can only do hysteresis — PID requires a
variable-output actuator. Humidity and temperature loops jointly serve the **VPD target** (VPD is
computed from fused temperature + RH).

**CO₂ on/off with vent interlock**
Injector opens when CO₂ drops below `co2_target_ppm`; closes when reached. Hard interlock: the
injector is disabled whenever vent position exceeds `co2_vent_interlock_threshold_pct`. Enriching
while venting wastes CO₂ immediately.

### Medium Loops — Scheduled and Adaptive (minutes to hours)

**Irrigation scheduler (per zone)**
Triggered by two conditions: the zone's time-of-day `schedule` AND soil moisture below
`moisture_low_threshold`. Irrigates until `moisture_high_threshold`, then a `drain_period_secs` gap
must elapse before another cycle, to prevent root saturation. One scheduler instance per zone.

**Lighting — DLI accumulation**
Tracks cumulative PAR over the day (Daily Light Integral, mol/m²/day). If the `dli_target_mol` is
not on track by midday, supplemental grow lights engage for the afternoon; the shade screen sheds
excess solar heat/light. Lights also extend photoperiod for day-length-sensitive crops.

---

## 7. Safety Interlocks

Always active. They take **unconditional priority** over all control loops **and** over manual
override — an operator cannot suppress a safety response.

| Condition | Response |
|---|---|
| Temperature > critical max | Override all loops; run all cooling at full; raise alarm |
| Temperature probes in total disagreement (no two agree) | Treat temperature as unavailable; hold safe state; raise alarm |
| CO₂ > safety ceiling | Open vents; disable injector; raise alarm |
| Irrigation fault (no moisture change after valve opens) | Disable zone; raise alarm |

---

## 8. Sensor Fault Detection (non-temperature sensors)

Temperature fault handling is covered by [fusion](#5-sensor-fusion--redundant-temperature-with-voting).
Every other sensor runs two detectors each tick:

- **Stuck value** — reading unchanged beyond a configurable duration (sensor frozen).
- **Out-of-range** — reading outside physical plausibility bounds.

On fault, the controller applies a **fail-safe** response (bias toward the action least likely to
harm the crop), flags the sensor, logs it, publishes a fault event over MQTT, and surfaces it in the
REST health endpoint.

| Sensor | Out-of-range bound | Fault response |
|---|---|---|
| Humidity | 0–100 % RH | Disable misters; suspend the VPD loop; alarm |
| CO₂ | ~200–5000 ppm | Disable injector (fail-closed — never enrich blind); alarm |
| PAR | sensor range | Fall back to time-based lighting schedule; alarm |
| Soil moisture (per zone) | 0–1 VWC | Disable that zone's irrigation (fail-closed — never water blind); alarm |

---

## 9. Actuator Constraints

A constraint layer sits between control output and the HAL, enforcing limits that reflect real
hardware behavior. All limits are configurable in TOML.

| Actuator | Constraint |
|---|---|
| Roof vents / shade screen | Maximum slew rate (%/s) — motors cannot move instantly |
| Heater / CO₂ injector | Minimum on-time and off-time — anti short-cycle protection |
| Fans | Speed ramp-rate limit — gradual speed changes |
| Irrigation valves | Minimum open time — ensures meaningful water delivery |

These constraints are applied after safety interlocks resolve the desired output, so a safety
response is still shaped by hardware limits (e.g., vents open at max slew rate, not instantaneously).

---

## 10. Manual Override

The REST API can force any actuator to a specific state, bypassing its control loop:

- Each actuator has an **override flag + forced value** in controller state.
- While an override is active, the relevant control loop skips that actuator and the forced value is
  used instead.
- An override is cleared via REST or auto-expires after a configurable timeout (so a forgotten
  override cannot strand the greenhouse indefinitely).
- Active overrides are published over MQTT and WebSockets as part of system state.
- **Safety interlocks still apply.** An override cannot suppress a critical-temperature or
  CO₂-ceiling response; the interlock wins.

---

## 11. Interfaces

Telemetry, configuration, and control surfaces. Wire-format details (topic names, payload schemas)
are defined in [`contracts/`](../../../contracts/) — this section lists responsibilities only.

| Interface | Role |
|---|---|
| **MQTT** | Publishes sensor readings, actuator states, fault events, and system state; subscribes to actuator command topics |
| **REST API** | Setpoint/threshold CRUD, zone status, manual-override management, system health |
| **WebSockets** | Live log stream and real-time sensor/actuator event feed for the dashboard |

---

## 12. Scope — Deferred Controller Capabilities

Controller features intentionally **out of scope** for Phase 1 (most are Phase 3 territory). Physical
elements that are simply not instrumented are listed in
[`physical-system-single.md`](./physical-system-single.md#out-of-scope-for-this-physical-model) instead.

| Deferred capability | Why / where it belongs |
|---|---|
| Predictive / weather-based control | Needs external forecast feeds + planning — Phase 3 |
| Energy-cost optimization | Needs price data + a planning horizon — Phase 3 |
| Advanced sensor fusion (Kalman / complementary, cross-quantity) | Estimation-theory methods need the physics model — Phase 3. Phase 1 includes only redundant-temperature median voting (§5) |
| Full heat/mass-balance HAL physics | Reserved for the Phase 3 digital twin; Phase 1 uses coupled first-order lag (§3) |
| Combustion heater | Multi-variable actuator (heat + CO₂ + humidity) that breaks the independence assumption of the current control loops; requires actuator-selection coordination logic above the individual PIDs — out of scope for Phase 1 |

---

## 13. Deployment

The controller never runs on a physical device — the HAL ([§3](#3-hal--simulation-model)) is pure simulation, so there is no real hardware path and nothing to run on embedded hardware. How the process is packaged depends on the phase:

- **Phase 1 (standalone):** the controller runs as a **native binary directly on Windows** (the development machine). It is configured by a **TOML file** ([§4](#4-configuration--setpoints)) passed at startup, and its values come from that file plus direct REST edits — there is no platform above it. This is the simplest path for developing and testing the control logic itself.
- **Phase 2 (managed):** the same controller runs as a **Docker container** alongside the platform stack, configured by a **TOML file mounted at startup**. Multiple containers run concurrently on one machine — one per greenhouse — connecting to the platform over the local Docker network. See [Phase 2 spec §12](./spec-climate-platform.md#12-deployment) for the named-service / variable-N deployment model.

In both cases configuration is the same TOML described in [§4](#4-configuration--setpoints): the controller's unique `controller_id` (its greenhouse identity when registering with the platform), all setpoints, HAL simulation parameters (time constants, coupling gains, disturbance profiles), and zone definitions. Whether native or containerized, each controller instance is one independent greenhouse with no shared state.

Structural changes (adding/removing zones, changing HAL parameters) require a config file edit and a restart, consistent with the startup-vs-runtime boundary in [§4](#4-configuration--setpoints).
