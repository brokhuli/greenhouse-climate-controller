# Controller — HAL & Simulation Model

> **Purpose:** Define the Hardware Abstraction Layer and the simulation behind it —
> the boundary that makes the controller hardware-agnostic, the **coupled
> first-order-lag** dynamics, the actuator **coupling matrix**, the
> actuator-as-a-set-of-effects interface invariant (the one Phase 4 seam), the
> hidden-disturbance model, and the determinism guarantee. This is the *plant* the
> [control loops](./spec-controller-control-loops.md) fight; the loops never see
> inside it. Physical inventory (what sensors/actuators exist, the real-world
> coupling) is owned by [`physical-system-single.md`](../physical-system-single.md);
> this file owns the *software model* of it.

---

## 1. The HAL boundary

The HAL replaces real hardware with a software simulation behind a **trait**: a set
of operations the pipeline calls to *read sensors* and *command actuators*. The
pipeline depends only on this trait, never on the simulator.

```
control pipeline ──▶ HAL trait ──▶  ┌─ simulated backend (Phase 1)        ┐
   (reads/commands)                  ├─ real-hardware backend (hypothetical)│  one impl
                                     └─ Phase 4 combustion-heater backend  ┘  at a time
```

This boundary buys two things:

- **Swappability** (`P1-MOD-1`). A real-hardware HAL, or a new actuator, is a new
  backend implementing the same trait — not a rewrite of the control logic.
- **A clean control/plant split.** The controller sees *only sensor outputs*;
  simulation internals and disturbances are hidden. The control problem is
  therefore identical whether the readings come from a simulator or a real
  greenhouse.

The simulation's fidelity is deliberately bounded: **coupled first-order lag**, not
a full heat/mass-balance model. Rich physics is reserved for the
[Phase 3 digital twin](../optimizer/03-spec-optimizer-digital-twin.md#1-the-forward-model)
(see [§6](#6-bounded-fidelity)).

---

## 2. Coupled first-order lag

Each simulated state variable — air temperature, humidity, CO₂, PAR, and per-zone
soil moisture — moves toward a target value at a rate set by a per-variable **time
constant τ**. Discretely, per tick of length `Δt`:

```
x(t+Δt) = x(t) + (Δt / τ) · ( x_target(t) − x(t) )

where x_target(t) = x_ambient + Σ (actuator effects) + Σ (hidden disturbances)
```

The target is shifted by whatever actuators are active and by hidden disturbances.
This produces realistic gradual response — a heater warms the air over minutes, not
instantly — which is exactly what makes the control loops non-trivial to tune (a
naive controller overshoots a lagged plant).

Example default time constants (the canonical table is the
[default-parameters reference](./spec-controller-config-and-parameters.md#default-parameters-reference);
all are TOML-configurable):

| Variable | τ (default) | Rationale |
|---|---|---|
| Temperature | 120 s | Air mass takes minutes to respond to heat input |
| Humidity | 60 s | Moisture responds faster than bulk temperature |
| CO₂ | 30 s | Injection/venting changes concentration quickly |

---

## 3. Coupling matrix

Actuators affect **multiple** variables at once — this is what makes the controller
experience the
[coupling problem](../physical-system-single.md#the-coupling-problem) as a real
force rather than a theoretical note. Each actuator contributes a *set* of effects
to the targets in [§2](#2-coupled-first-order-lag):

| Actuator | Effects on simulated state |
|---|---|
| Heater | temperature ↑ |
| Fans | temperature → outdoor, humidity ↓, CO₂ → ambient |
| Roof vents | temperature → outdoor, humidity → ambient, CO₂ → ambient (~420 ppm) |
| Misters / foggers | humidity ↑, temperature ↓ (evaporative) |
| CO₂ injector | CO₂ ↑ (clean injection; a combustion variant would also add heat + humidity) |
| Grow lights | PAR ↑, temperature ↑ (waste heat) |
| Shade screen | PAR ↓, reduces incoming solar heat gain (temperature effect) |
| Irrigation valve (per zone) | soil moisture ↑ (that zone) |

Coupling gains (how strongly each effect pushes its target) are TOML-configurable.

---

## 4. The actuator-effect-set invariant

> **Interface constraint — actuators have a *set* of effects, not one.** The HAL
> actuator interface models each actuator as producing a **set of effects on
> climate variables**, never a one-to-one actuator→variable mapping. The actuators
> above each happen to affect mostly one variable, but the interface must **not**
> encode single-variable as an invariant — no field or type parameter pinning an
> actuator to one target.

This is the **one** forward-looking accommodation in the core product for Phase 4's
combustion heater — a single device that raises temperature, CO₂, and humidity at
once. Because the interface already speaks in effect-sets, the burner lands in
Phase 4 as a *new HAL backend implementing the same trait*, not a HAL rewrite. The
coupling lives here in the HAL; the [control loops](./spec-controller-control-loops.md)
target *variables*, not actuators, so this costs nothing above the HAL. See
[RFC-006](../../../decisions/request-for-comments.md#rfc-006-phase-4-seam-strategy)
and [Phase 4 §3](../spec-phase4.md#3-combustion-heater--the-coupled-actuator).

This invariant is restated as a hard rule in
[constraints](./spec-controller-constraints.md#7-actuator-as-a-set-of-effects-invariant).

---

## 5. Hidden disturbance model

The simulation maintains internal state the controller **cannot** see — it only
ever reads sensor outputs. These disturbances create the load the controller must
fight:

- **Outdoor temperature** — static value or a daily profile; drives heat loss/gain
  via a heat-loss coefficient to the outside.
- **Solar / PAR day cycle** — natural light by time of day; drives natural PAR (so
  grow lights *supplement*) and solar heat gain.
- **Plant CO₂ uptake** — consumes CO₂ during light hours.
- **Per-zone soil drying** — soil moisture decays over time.
- **Ambient humidity drift.**

> **Boundary.** The controller sees only sensor readings; simulation internals and
> disturbances are hidden. This is what keeps the HAL swappable for real hardware
> and preserves a clean control/plant separation.

---

## 6. Bounded fidelity

Full physics — heat capacity, mass transfer, volumetric/spatial modeling — is
intentionally **out of scope** for Phase 1. The simulation is a coupled
first-order-lag approximation tuned to make control *interesting*, not to be
physically exact. The rich heat/humidity/CO₂ dynamics that need greenhouse volume
and crop physiology belong to the
[Phase 3 digital twin](../optimizer/03-spec-optimizer-digital-twin.md#1-the-forward-model);
the deferred-capability list is in
[constraints](./spec-controller-constraints.md#9-scope--deferred-controller-capabilities),
and the un-modeled *physical* elements in
[`physical-system-single.md`](../physical-system-single.md#out-of-scope-for-this-physical-model).

---

## 7. Determinism & seeding

The simulation is **deterministic under a fixed seed** (`P1-TEST-2`): given the
same seed, the same initial state, and the same sequence of commands, it produces
the same sequence of readings, tick for tick. Any stochastic element (sensor noise,
disturbance jitter) is driven by a seeded PRNG, never by wall-clock or OS entropy.

This is a prerequisite for the test strategy
([tech stack — testing](./spec-controller-tech-stack.md#testing)): control-loop and
interlock behavior can be asserted against reproducible plant responses, and a tuning
regression shows up as a diff in a fixed-seed run rather than as flake. Combined with
the latched-write model ([architecture §3](./spec-controller-architecture.md#3-real-time--scheduling-model)),
an entire run is replayable from (seed, config, command log).

---

## 8. Observed actuator state and fault injection

Sensor readings are not the only thing the HAL returns. For every actuator the trait
exposes **two** values: the **commanded** input the pipeline writes, and an **observed**
readback of the actuator's actual state. In the fault-free case the two agree (the
observed value is the commanded one after any modeled device dynamics). The gap between
them is what makes a *stuck* or *jammed* actuator detectable — without a readback, the
controller could only ever assume its commands took effect.

- **Why a separate channel.** A real-hardware HAL would source `observed` from device
  feedback (limit switches, position encoders, current sensing); the simulated HAL
  synthesizes it. Either way the control side compares commanded against observed
  identically — the [actuator health monitor](./spec-controller-safety-and-constraints.md#5-actuator-health-monitoring)
  lives above the trait and never knows which backend produced the readback, preserving
  the clean control/plant split ([§1](#1-the-hal-boundary), `P1-MOD-1`).
- **Injectable actuator faults.** The simulated backend can inject actuator faults under
  the seed, the counterpart to the sensor faults the sensing stage already handles:
  - **Stuck-on / stuck-off** — `observed` freezes at a state and ignores subsequent
    commands (the climate effect follows the frozen state, not the command).
  - **No-effect** — `observed` tracks the command normally, but the actuator's
    [coupling-matrix effect](#3-coupling-matrix) is suppressed, so the variable it should
    drive doesn't move. This is the case position feedback alone can't catch, which is why
    the monitor also checks for a climate response.
- **Deterministic, like everything else.** Injection timing and selection are driven by the
  seeded PRNG ([§7](#7-determinism--seeding)), never wall-clock — so an actuator-fault
  scenario replays identically and the
  [health-detection assertions](./spec-controller-safety-and-constraints.md#5-actuator-health-monitoring)
  are stable (`P1-TEST-2`).

This stays within [bounded fidelity](#6-bounded-fidelity): a fault is a flag that gates the
existing lag/coupling model, not a new physics path.

---

## 9. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| What the loops do with the readings | feeds | [`spec-controller-control-loops.md`](./spec-controller-control-loops.md) |
| How readings are conditioned before loops | feeds | [`spec-controller-sensing.md`](./spec-controller-sensing.md) |
| Commanded-vs-observed actuator-health detection | feeds | [`spec-controller-safety-and-constraints.md`](./spec-controller-safety-and-constraints.md#5-actuator-health-monitoring) |
| Where the HAL sits in the tick | composed by | [`spec-controller-architecture.md`](./spec-controller-architecture.md#2-the-tick-pipeline) |
| τ / coupling-gain / disturbance defaults | consolidated in | [`spec-controller-config-and-parameters.md`](./spec-controller-config-and-parameters.md#default-parameters-reference) |
| Physical inventory + real-world coupling | mirrors | [`physical-system-single.md`](../physical-system-single.md) |
| The Phase 4 combustion-heater backend | seam for | [RFC-006](../../../decisions/request-for-comments.md#rfc-006-phase-4-seam-strategy), [Phase 4 §3](../spec-phase4.md#3-combustion-heater--the-coupled-actuator) |
| Determinism target `P1-TEST-2`, modularity `P1-MOD-1` | cited | [NFR doc](../../artifacts/non-functional-requirements.md) |
