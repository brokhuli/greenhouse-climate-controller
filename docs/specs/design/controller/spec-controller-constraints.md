# Controller — Constraints

> **Purpose:** The fixed boundaries the controller is built inside. These are not
> goals or preferences — quality goals live in the
> [NFR doc](../../artifacts/non-functional-requirements.md). Constraints are the
> **non-negotiable rules** imposed by the system's safety model, the phased
> roadmap, and prior decisions (RFCs/ADRs/the
> [constraints artifact](../../artifacts/constraints.md)). If a design choice
> conflicts with anything below, the design choice changes. The last section records
> what is deliberately **out of scope**.

Each entry: the constraint, **why** it exists, and **what it forces or forbids**.

---

## 1. Determinism & real-time

- **Why:** The controller is a safety-relevant control loop; behavior must be
  reproducible and bounded in time (`P1-PERF-1/2/3`, `P1-TEST-2`).
- **Forces:** A fixed-tick pipeline that runs to completion each tick; a
  seeded simulation ([HAL §7](./spec-controller-hal-simulation.md#7-determinism--seeding));
  latched REST writes applied at tick boundaries
  ([architecture §3](./spec-controller-architecture.md#3-real-time--scheduling-model)).
- **Forbids:** Wall-clock/entropy-driven simulation; mid-tick mutation of pipeline
  state; unbounded per-tick work.

## 2. Headless

- **Why:** The controller has no UI; visualization is the
  [Phase 2 frontend](../frontend/spec-frontend-overview.md)'s job
  ([interfaces §1](./spec-controller-interfaces.md#1-the-headless-principle)).
- **Forces:** Observability over MQTT + a REST `/health` surface; standalone
  inspection via MQTT tooling.
- **Forbids:** A local dashboard, a bundled web UI, or a controller-side WebSocket
  stream.

## 3. Crop-agnostic

- **Why:** The crop→setpoint mapping is owned *above* the controller
  ([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain),
  [config](./spec-controller-config-and-parameters.md#configuration-model)).
- **Forces:** The controller regulates to numeric setpoints it is given (TOML +
  REST); a crop profile resolves to setpoints elsewhere.
- **Forbids:** Any crop knowledge, crop tables, or growth-stage logic inside the
  controller.

## 4. REST is the sole write path

- **Why:** Telemetry flows out over MQTT; *all* control flows in over REST
  ([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain),
  [interfaces](./spec-controller-interfaces.md#3-rest--the-sole-write-path)). The
  REST API is unauthenticated on the trusted network
  ([RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)).
- **Forces:** Every inbound change (setpoints, thresholds, override) goes through
  REST and is latched to a tick boundary.
- **Forbids:** MQTT command topics; any side channel that mutates controller state.

## 5. HAL-swappable / no real hardware

- **Why:** The HAL is pure simulation; the controller never runs on a device
  ([constraints artifact](../../artifacts/constraints.md)), and the seam must stay
  open for a real (or Phase 4) backend (`P1-MOD-1`).
- **Forces:** Control logic depends on the HAL *trait*; the simulator is one
  implementation behind it ([HAL §1](./spec-controller-hal-simulation.md#1-the-hal-boundary)).
- **Forbids:** Pipeline code reaching past the trait into simulation internals; any
  embedded/RTOS assumption.

## 6. No physics model (bounded fidelity)

- **Why:** Full heat/mass-balance physics needs greenhouse volume + crop physiology
  and belongs to the [Phase 3 digital twin](../optimizer/03-spec-optimizer-digital-twin.md#1-the-forward-model).
- **Forces:** Phase 1 uses coupled first-order lag
  ([HAL §2](./spec-controller-hal-simulation.md#2-coupled-first-order-lag)) — enough
  to make control non-trivial, no more.
- **Forbids:** Volumetric/spatial modeling or full thermodynamics in the Phase 1
  HAL.

## 7. Actuator-as-a-set-of-effects invariant

- **Why:** The single forward-looking accommodation for the Phase 4 combustion
  heater ([RFC-006](../../../decisions/request-for-comments.md#rfc-006-phase-4-seam-strategy));
  the HAL models actuators as a *set* of effects on variables
  ([HAL §4](./spec-controller-hal-simulation.md#4-the-actuator-effect-set-invariant)).
- **Forces:** The HAL actuator interface to allow many effects per actuator; control
  loops to target *variables*, not actuators.
- **Forbids:** Any field or type parameter pinning an actuator to a single variable.

## 8. Structural changes require a restart

- **Why:** Runtime-mutable state can change mid-run, but topology must rebuild
  against a consistent config
  ([config](./spec-controller-config-and-parameters.md#startup-vs-runtime),
  [constraints artifact](../../artifacts/constraints.md)).
- **Forces:** Adding/removing zones and changing HAL τ/coupling parameters to be a
  config-file edit + restart.
- **Forbids:** Runtime zone-topology edits or live HAL-parameter changes over REST.

## 9. Scope — deferred controller capabilities

Controller features intentionally **out of scope** for Phase 1 (most are Phase 3
territory). Physical elements that are simply not instrumented are listed in
[`physical-system-single.md`](../physical-system-single.md#out-of-scope-for-this-physical-model)
instead.

| Deferred capability | Why / where it belongs |
|---|---|
| Predictive / weather-based control | Needs external forecast feeds + planning — [Phase 3](../optimizer/01-spec-optimizer-overview.md) (weather-reactive itself is [Phase 4](../spec-phase4.md)) |
| Energy-cost optimization | Needs price data + a planning horizon — [Phase 3](../optimizer/01-spec-optimizer-overview.md) |
| Advanced sensor fusion (Kalman / complementary, cross-quantity) | Estimation-theory methods need the physics model — Phase 3. Phase 1 includes only redundant-temperature median voting ([sensing §2](./spec-controller-sensing.md#2-redundant-temperature-fusion-tmr)) |
| Full heat/mass-balance HAL physics | Reserved for the Phase 3 digital twin; Phase 1 uses coupled first-order lag ([HAL §2](./spec-controller-hal-simulation.md#2-coupled-first-order-lag)) |
| Combustion heater | Multi-variable actuator (heat + CO₂ + humidity) that breaks the independence assumption of the current control loops; needs actuator-selection coordination above the individual loops — [Phase 4](../spec-phase4.md#3-combustion-heater--the-coupled-actuator). The only accommodation now is the HAL [effect-set invariant](#7-actuator-as-a-set-of-effects-invariant) ([RFC-006](../../../decisions/request-for-comments.md#rfc-006-phase-4-seam-strategy)) |

---

## 10. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| The real-time model these rules constrain | constrains | [`spec-controller-architecture.md`](./spec-controller-architecture.md) |
| The HAL seam + bounded fidelity | constrains | [`spec-controller-hal-simulation.md`](./spec-controller-hal-simulation.md) |
| Crop→setpoint authority above the controller | defers to | [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) |
| Phase 4 seam strategy | defers to | [RFC-006](../../../decisions/request-for-comments.md#rfc-006-phase-4-seam-strategy) |
| System-wide constraint inventory | mirrors | [constraints artifact](../../artifacts/constraints.md) |
| Quality targets (not constraints) | separate from | [NFR doc](../../artifacts/non-functional-requirements.md) |
