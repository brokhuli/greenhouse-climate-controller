# Phase 4 — Coupled Actuation + Weather-Reactive Optimization (Spec)

Architectural specification for the Phase 4 **stretch goal**: the two hardest, most realistic
capabilities the core three-phase product deliberately deferred — a **combustion heater** (one
device that couples temperature + CO₂ + humidity) and a **real weather feed** (live + forecast)
enabling **weather-reactive predictive control**. This is taken on only *after* the Phase 1–3
product is finished; it does not block or alter the core deliverable.

Phase 4 spans **two layers**. It adds a coupled actuator and **actuator-selection coordination** to
the Phase 1 controller, and it extends the Phase 3 optimizer with weather-reactive planning and
combustion-aware device selection. This spec describes the **software** at both layers. For the
physical system whose dynamics it adds to — the combustion burner and the weather it reacts to — see
[`physical-system-single.md`](./physical-system-single.md) and
[`physical-system-multi.md`](./physical-system-multi.md); for the controller it extends, see
[`spec-climate-controller.md`](./spec-climate-controller.md); for the optimizer it builds on, see
[`spec-climate-optimizer.md`](./spec-climate-optimizer.md).

> Scope note: this is an architectural spec (components, responsibilities, behavior, configuration).
> Concrete code/module/class design is deferred until implementation. Wire formats (MQTT topics,
> payload schemas, REST shapes) are **referenced**, not redefined here — they live in
> [`contracts/`](../../../contracts/), the single source of truth all phases conform to. The
> conventions those contracts follow (topic taxonomy, `greenhouse_id` / `zone_id` identity, payload
> envelope, JSON Schema format + versioning) are fixed by
> [RFC-007](../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).
> The full set of system contracts — every cross-component boundary — is catalogued in
> [`spec-contracts.md`](./spec-contracts.md).

---

## 1. Overview

Phase 4 is the **stretch goal**: it removes the two simplifying assumptions that kept the core
product tractable.

**The independence assumption.** The core product models thermal and CO₂ control as *independent*
devices — an electric heater that only adds heat, and a clean CO₂ injector that only adds CO₂ — so
each control loop can chase its variable without commanding another. Phase 4 introduces a
**combustion heater**: a single burner that raises **temperature, CO₂, and humidity at once**
([physical-system-single.md — Combustion heater](./physical-system-single.md#out-of-scope-for-this-physical-model)).
With two ways to add heat (electric vs. burner) and two ways to add CO₂ (clean injector vs. burner),
the system can no longer run independent loops — it must **choose the device**. That choice is a
control-layer concern that runs on the live system, so it is added to the **Phase 1 controller** as
an actuator-selection coordination layer above the existing PIDs
([P1 §12](./spec-climate-controller.md#12-scope--deferred-controller-capabilities)).

**The deterministic-disturbance assumption.** The Phase 3 optimizer anticipates only **clock-known**
disturbances — the diurnal solar/temperature curve and the day/night schedule — which need no
weather feed ([P3 §3](./spec-climate-optimizer.md#3-digital-twin--simulation-engine)). Phase 4
ingests a **real weather feed** (live outdoor conditions plus a site-wide forecast) and extends the
optimizer's digital twin to plan against a **stochastic future**: pre-positioning for a cold front,
a passing cloud, or a humid front rolling in
([physical-system-multi.md — Weather Forecast](./physical-system-multi.md#weather-forecast)). This is
**weather-reactive** predictive control, a strict superset of Phase 3's clock-known anticipation.

The two capabilities reinforce each other: a richer actuator set (burner vs. electric, injector vs.
burner) gives the weather-reactive planner more ways to meet incoming conditions economically, and a
forecast gives the device-selection problem a horizon to optimize over. Everything else is inherited
from Phases 1–3 unchanged — including the rule that the optimizer's downward influence is
**setpoint-only, routed through Phase 2** ([§9](#9-interfaces--integration)).

---

## 2. Architecture

Phase 4 changes two layers and leaves the data path between them intact. The weather feed enters at
the optimizer; the combustion heater and its selection logic live in the controller; the optimizer
still writes **setpoints only**, **through Phase 2**, exactly as in Phase 3.

```
External Weather API
      │  live outdoor conditions + site-wide forecast
      ▼
Weather Ingestion                    ← normalizes live + forecast into the planning horizon
      │  forecast trajectory
      ▼
Digital Twin / Simulation (P3+)      ← rolls climate forward against a STOCHASTIC future
      │  predicted trajectory                + a combustion model (joint heat / CO₂ / humidity)
      ▼
LLM Planner (P3+)                    ← combustion-aware, weather-reactive plan
      │  candidate plan
      ▼
Constraint Engine (P3)               ← crop-safe bounds + physical limits (advisory pre-filter)
      │  within bounds
      ▼
Plan Applier ──► Phase 2 REST API ──► reconciles intended state (setpoint-only)
                                            │
                                            ▼
                              Phase 1 Controller (P1+)
                                ├─ Actuator-Selection Coordination   ← chooses the device
                                │     (electric vs. burner; injector vs. burner)
                                ├─ Control Loops (PIDs / bands)       ← unchanged
                                ├─ Safety Interlocks (unconditional)  ← + combustion interlocks
                                └─ HAL + Combustion Heater (temp↑ / CO₂↑ / humidity↑)
```

| Component | Layer | Responsibility |
|---|---|---|
| Weather Ingestion | Optimizer | Pull and normalize live outdoor conditions + the site forecast into the twin's planning horizon |
| Digital Twin / Simulation | Optimizer | Extend the Phase 3 forward model with a **combustion model** and a **stochastic, forecast-driven** future |
| LLM Planner | Optimizer | Propose plans that are both **weather-reactive** and **combustion-aware** (which device, not just what level) |
| Constraint Engine / Plan Applier | Optimizer | Unchanged from Phase 3 — validate, then write setpoints through Phase 2 |
| Actuator-Selection Coordination | Controller | Choose between coupled devices (electric vs. burner, injector vs. burner) above the PIDs, in real time |
| Combustion Heater (HAL) | Controller | Simulate one actuator that raises temperature, CO₂, and humidity together |
| Combustion Safety Interlocks | Controller | Unconditional limits specific to a burner (see [§8](#8-constraints--safety)) |

The optimizer remains a **client** of Phase 2, not a peer of Phase 1: the new weather intelligence
changes *what* setpoints it proposes, never *how* they reach the controller. The combustion heater
and its selection coordination are entirely controller-owned and run unconditionally on the live
system, independent of whether the optimizer is online.

---

## 3. Combustion Heater — the Coupled Actuator

The combustion heater is a natural-gas/propane **burner** simulated in the controller's HAL. Unlike
the core product's electric heater (temperature only) paired with a clean CO₂ injector (CO₂ only),
the burner raises **three** variables from one device:

| Actuator | Effects on simulated state |
|---|---|
| Combustion heater (burner) | temperature ↑, CO₂ ↑, humidity ↑ |

This extends the HAL **coupling matrix** ([P1 §3](./spec-climate-controller.md#3-hal--simulation-model))
with the entry the core product explicitly held back — the burner row foreshadowed by the CO₂
injector note ("a combustion variant would also add heat + humidity"). Because Phase 1's HAL actuator
interface was deliberately shaped to model a *set* of effects rather than a one-to-one
actuator→variable mapping ([RFC-006](../../decisions/request-for-comments.md#rfc-006-phase-4-seam-strategy)),
the burner is added as a **new HAL backend implementing the same actuator trait** — an additive
change, not a rewrite of the trait or the control loops above it. It makes the
**coupling problem** ([physical-system-single.md — The Coupling Problem](./physical-system-single.md#the-coupling-problem))
sharper: the burner is the canonical example of one actuator driving three coupled variables at once,
so naive independent loops will actively fight it (e.g. running the burner for heat over-enriches CO₂
and raises humidity, working against the VPD and CO₂ loops).

The burner's simulation obeys the same **coupled first-order lag** model as every other actuator —
each affected variable moves toward its shifted target at that variable's time constant τ. The
combustion model's gains (heat / CO₂ / humidity contribution per unit burn) are HAL parameters,
configurable in TOML alongside the existing coupling gains ([§10](#10-configuration)).

---

## 4. Actuator-Selection Coordination (Controller Layer)

Adding the burner gives the controller **redundant means** to two ends:

- **Two ways to add heat:** electric heater (clean, temperature only) vs. burner (couples CO₂ +
  humidity).
- **Two ways to add CO₂:** clean injector (CO₂ only) vs. burner (couples heat + humidity).

Independent PID/hysteresis loops cannot resolve this — a temperature loop and a CO₂ loop each
choosing a device in isolation can double-heat, double-enrich, or fight each other. Phase 4 therefore
inserts an **actuator-selection coordination** stage **above the individual control loops**
([P1 §6](./spec-climate-controller.md#6-control-loops)), the capability the controller spec names as
the prerequisite for a combustion heater
([P1 §12](./spec-climate-controller.md#12-scope--deferred-controller-capabilities)).

Its job is to map the loops' *demands* (how much heat, how much CO₂) onto the *cheapest
non-conflicting combination of devices* that satisfies them — e.g. preferring the burner when both
heat **and** CO₂ are wanted (one device serves both), and the clean injector/electric heater when
only one is wanted or when the burner's humidity side-effect would push VPD out of band.

Where this sits in the pipeline:

- It runs **downstream of the control loops** (which still compute desired heat/CO₂ demand) and
  **upstream of safety interlocks and actuator constraints** — selection decides *which* actuators
  carry the demand; interlocks and slew/min-cycle limits still shape the result
  ([P1 §7](./spec-climate-controller.md#7-safety-interlocks),
  [P1 §9](./spec-climate-controller.md#9-actuator-constraints)).
- It is **deterministic and real-time**, part of the controller's fixed tick — not an LLM or a
  planner. The optimizer *informs* selection over the horizon ([§7](#7-combustion-aware-planning))
  by refining setpoints and preferences, but the live, per-tick device choice is controller-owned and
  runs whether or not the optimizer is connected.
- **Manual override and safety still win.** An operator override forces a specific actuator state
  ahead of selection ([P1 §10](./spec-climate-controller.md#10-manual-override)); safety interlocks
  override everything ([§8](#8-constraints--safety)).

This is what lifts the cap that kept Phase 1 at 6/10: the controller now coordinates *which* device
acts, not merely *how hard* each independent device runs.

Device-selection decisions (which heat/CO₂ source ran, and why) are published in telemetry for
after-the-fact analysis — `P4-OBS-1` in
[`non-functional-requirements.md`](../artifacts/non-functional-requirements.md).

---

## 5. Weather Feed & Forecast Ingestion (Optimizer Layer)

Phase 4 introduces the first **external** data source in the system: a real weather feed. It has two
parts ([physical-system-multi.md — Site Environment](./physical-system-multi.md#site-environment)):

- **Live outdoor conditions** — the current outdoor temperature, sunshine, wind, and humidity the
  site is exposed to right now.
- **Site-wide forecast** — a prediction of where those conditions are heading over the coming hours
  and days ([physical-system-multi.md — Weather Forecast](./physical-system-multi.md#weather-forecast)).

Because every greenhouse at a site shares **one sky**, a **single forecast describes the whole
site** at once — it is ingested once per site, not per greenhouse, even though each greenhouse is
still planned independently ([P3 §1](./spec-climate-optimizer.md#1-overview)). The feed is the
authoritative site weather source the core product deliberately omitted
([physical-system-multi.md — Common Inputs](./physical-system-multi.md#common-inputs--out-of-scope)).

Ingestion normalizes the provider's payload (units, cadence, horizon) into the trajectory the digital
twin consumes, aligned to the planning horizon. A forecast is, in effect, **advance notice of the
disturbance** the greenhouses will have to fight — a cold night to hold off, a sunny afternoon's heat
to shed, a humid front to pre-empt.

The committed fetch behavior — a forecast fetch completes quickly and is cached, a failed fetch falls
back to the last-known forecast, and ingestion never blocks the control tick — is `P4-PERF-1` in
[`non-functional-requirements.md`](../artifacts/non-functional-requirements.md).

---

## 6. Weather-Reactive Predictive Control (Optimizer Layer)

Phase 3's digital twin anticipates only the **deterministic** diurnal cycle. Phase 4 extends it to
plan against a **stochastic future** derived from the forecast: the twin rolls climate forward not
just "when the sun predictably rises," but "when *this* front arrives," pre-positioning actuators for
conditions that are real, variable, and only known probabilistically.

Concretely, the extended twin:

- Drives its forward simulation with the **forecast trajectory** as the outdoor boundary condition,
  replacing (or augmenting) the static diurnal disturbance profile used in Phase 3.
- Plans **weather-reactive** moves — e.g. pre-heat before a cold night, shed heat ahead of a sunny
  afternoon, lower the humidity target before a humid front — that Phase 3 cannot make because it
  cannot see them coming.
- Accounts for **forecast uncertainty**: the future is a prediction, not a schedule, so plans should
  be robust to the forecast being early, late, or wrong, and should re-plan as the live feed updates.

This is a **superset** of Phase 3's anticipation: clock-known disturbances are still anticipated; the
forecast simply adds the variable ones. Everything downstream — the constraint engine, the
confidence-gated application path, and the setpoint-only write through Phase 2 — is unchanged
([P3 §5](./spec-climate-optimizer.md#5-constraint-engine--safety),
[P3 §6](./spec-climate-optimizer.md#6-setpoint-refinement--application)).

---

## 7. Combustion-Aware Planning (Optimizer Layer)

The combustion heater turns Phase 3's **coupling-aware planning**
([P3 §7](./spec-climate-optimizer.md#7-optimization-objectives)) into a genuine **combinatorial
actuator-selection problem**. Phase 3 chooses the best *combination of levels* across coupled
actuators (vent / fan / mister / heater) to hit VPD + DLI + CO₂ together; Phase 4 must additionally
choose **which device** provides heat and CO₂, because the burner couples them while the electric
heater and clean injector do not.

The planner's combustion model lets it reason about trade-offs over the horizon, for example:

- Use the **burner** when both heat and CO₂ are wanted and the humidity side-effect keeps VPD in band
  — one device, often cheaper, serving two goals.
- Fall back to the **electric heater + clean injector** when only one variable is wanted, or when the
  burner's humidity contribution would push VPD out of the crop-safe envelope.
- Weigh the choice against the **cost / time-of-use signal** (fuel vs. electricity) and the incoming
  weather, within the **crop-safe bounds** the Phase 2 profile defines.

The optimizer expresses these decisions as **refined setpoints and selection preferences**, not
direct actuator commands — the live, per-tick device choice remains the controller's
([§4](#4-actuator-selection-coordination-controller-layer)). The plan is still a **structured**
artifact conforming to [`contracts/`](../../../contracts/), still gated by the constraint engine, and
still applied only through Phase 2.

---

## 8. Constraints & Safety

Phase 4 preserves the **layered safety model**, and the controller remains final
([P3 §5](./spec-climate-optimizer.md#5-constraint-engine--safety)).

- **Controller interlocks remain unconditional and controller-owned.** The existing critical-temp,
  CO₂-ceiling, and irrigation-fault interlocks ([P1 §7](./spec-climate-controller.md#7-safety-interlocks))
  still run every tick and take priority over the control loops, actuator-selection coordination, and
  manual override. The burner is bound by them like any other actuator — most directly, the existing
  **CO₂ safety ceiling** caps burner use whenever combustion would over-enrich (open vents, disable
  the source), and the **critical-temperature override** still forces full cooling regardless of which
  heat source was selected.
- **Combustion-specific interlocks** are added at the controller layer for the failure modes a burner
  introduces (e.g. burner-fault detection — heat/CO₂ commanded but no response — and fail-safe
  shutoff). These are controller-owned and unconditional, consistent with the existing interlock
  table. The committed fallback-to-electric-heater latency on a combustion fault is `P4-REL-1` in
  [`non-functional-requirements.md`](../artifacts/non-functional-requirements.md).
- **Actuator-selection respects safety, not the reverse.** Selection chooses among devices, but
  whatever it chooses is still subject to interlocks and to actuator constraints (burner min on/off
  time, anti short-cycle), exactly as for the electric heater and injector
  ([P1 §9](./spec-climate-controller.md#9-actuator-constraints)).
- **The optimizer's constraint engine is unchanged and still advisory.** It validates weather-reactive,
  combustion-aware plans against crop-safe bounds and physical limits **before** they are applied, but
  it does not — and cannot — override the controller's interlocks. Because the optimizer still writes
  **setpoints only**, the controller's safety layer bounds everything that actually happens in the
  greenhouse.

---

## 9. Interfaces & Integration

Phase 4 adds exactly one new ingress — the weather feed — and reuses every existing interface.

| Interface | Direction | Role |
|---|---|---|
| **External Weather API** | Provider → optimizer | New ingress: live outdoor conditions + site-wide forecast for the planning horizon |
| **TimescaleDB** | Phase 2 store → optimizer | Unchanged — read-only history per greenhouse ([P3 §8](./spec-climate-optimizer.md#8-interfaces--integration)) |
| **Phase 2 REST API** | Optimizer → platform | Unchanged — write refined setpoint bundles; platform reconciles to the controller |
| **MQTT / REST (controller)** | Platform ↔ controller | Unchanged — the burner appears as additional actuator state/commands per [`contracts/`](../../../contracts/) |

The downward path is **identical to Phase 3**: the optimizer writes setpoints **through Phase 2**,
which remains the single authority on intended state; it never opens its own channel to the controller
and never publishes actuator commands ([P3 §6](./spec-climate-optimizer.md#6-setpoint-refinement--application)).
New burner telemetry and commands are **referenced** from [`contracts/`](../../../contracts/), the
shared source of truth — this spec does not redefine wire formats. The weather provider is an external
dependency; its payload is normalized at ingestion ([§5](#5-weather-feed--forecast-ingestion-optimizer-layer))
so the rest of the optimizer is provider-agnostic.

---

## 10. Configuration

Phase 4 extends the existing configuration surfaces rather than introducing a new one. Optimizer-layer
settings follow the Phase 3 convention (environment variables / the Compose file
[P3 §9](./spec-climate-optimizer.md#9-configuration)); the burner and its HAL gains follow the Phase 1
convention (per-greenhouse TOML loaded at startup
[P1 §4](./spec-climate-controller.md#4-configuration--setpoints)).

Optimizer layer (extends the Phase 3 service config):

```toml
[weather]
provider = "open-meteo"                 # external weather/forecast feed
endpoint = "https://api.example/forecast"
forecast_horizon_hours = 48             # how far ahead to plan against the forecast
refresh_secs = 900                      # how often to pull live + forecast updates
# one feed per site (shared sky); greenhouses are still planned one at a time

[planning]
# horizon_hours / objective_weights inherited from Phase 3
combustion_aware = true                 # enable burner device-selection in planning
```

Controller layer (extends the Phase 1 TOML — burner actuator + its coupling gains):

```toml
[actuators.combustion_heater]
enabled = true
min_on_secs = 120                       # anti short-cycle, like other thermal actuators
min_off_secs = 120

[hal.combustion_gains]                  # joint effect per unit burn (coupled first-order lag)
temperature_c_per_unit = 0.8
co2_ppm_per_unit = 40
humidity_pct_per_unit = 1.5

[selection]
prefer_burner_when_heat_and_co2 = true  # bias device selection toward the coupled device
```

Per-greenhouse inputs the optimizer needs (which house, its crop-safe bounds) are still read from
Phase 2 at cycle time, not configured here.

---

## 11. Scope — Deferred / Out of Scope

Even as a stretch goal, Phase 4 holds a firm boundary: it adds **one coupled actuator** and **one
weather feed**, and nothing else from the deferred list.

| Deferred / excluded | Why / where it belongs |
|---|---|
| Site-wide orchestration | Coordinated behavior across greenhouses (staggering loads, sharing constrained resources) still needs a shared-infrastructure model that is out of scope; like Phase 3, Phase 4 plans **one greenhouse at a time** ([P3 §10](./spec-climate-optimizer.md#10-scope--deferred--out-of-scope), [physical-system-multi.md](./physical-system-multi.md#out-of-scope-for-this-site-model)) |
| Shared fuel / supply contention | The burner draws from an **assumed-infinite** fuel supply; shared-tank depletion and contention remain unmodeled site-level physics ([physical-system-multi.md — Common Inputs](./physical-system-multi.md#common-inputs--out-of-scope)) |
| Central heating plant (boiler) | The coupled device modeled is a **per-greenhouse burner**, not a site boiler piping heat to many houses ([physical-system-multi.md](./physical-system-multi.md#common-inputs--out-of-scope)) |
| Direct actuator commanding by the optimizer | Driving actuators — including the burner and the device choice — is **controller-owned** ([§4](#4-actuator-selection-coordination-controller-layer)); the optimizer's downward influence stays **setpoint-only**, through Phase 2 |
| Safety authority for the optimizer | Combustion and climate interlocks remain **controller-owned** and unconditional; the optimizer's constraint engine is an advisory pre-filter and never overrides them ([§8](#8-constraints--safety)) |
| Introducing the crop → targets mapping | Still **owned by Phase 2** ([P2 §5](./spec-climate-platform.md#5-crop-profiles--setpoint-resolution)); Phase 4 plans only **within** the crop-safe bounds |
| Other un-instrumented physical elements | Nutrient subsystem, root-zone temperature, evaporative pads, spatial gradients, and site geometry remain out of scope ([physical-system-single.md](./physical-system-single.md#out-of-scope-for-this-physical-model)) |
