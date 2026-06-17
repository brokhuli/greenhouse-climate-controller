# Controller Spec — Overview & Index

> **Purpose:** This is the entry point and anchor for the **Phase 1 greenhouse
> climate controller** spec set. It says what the controller is, how it fits the
> phased system, how it connects to everything around it, and — via the
> [cross-spec map](#6-cross-spec-map) — which document owns which concern. Read
> this file first; read the others for detail.

This set is the **top-level design spec for Phase 1**. It sits alongside the
[platform](../platform/spec-platform-overview.md), [optimizer](../optimizer/01-spec-optimizer-overview.md),
and [Phase 4](../spec-phase4.md) specs, and one altitude **above** the wire
contracts in [`contracts/`](../../../../contracts/). The discipline throughout
mirrors the [frontend spec set](../frontend/01-spec-frontend-overview.md):
**reference, do not redefine.** Wire formats live in
[`contracts/`](../../../../contracts/); the physical inventory being controlled
lives in [`physical-system-single.md`](../physical-system-single.md); quality
targets live in the [NFR doc](../../artifacts/non-functional-requirements.md);
cross-cutting decisions live in the
[RFCs](../../../decisions/request-for-comments.md). This set consumes all of them.

---

## 1. What the controller is

Phase 1 is a **deterministic, real-time control loop** for a single simulated
greenhouse. It is a Rust process that, on a fixed tick, reads simulated sensors,
fuses and conditions those readings into trusted values, resolves the active
setpoints, runs a hierarchy of control loops, enforces unconditional safety
interlocks, shapes the result through actuator constraints, and drives simulated
actuators — all behind a Hardware Abstraction Layer (HAL).

Three properties define it and recur throughout this set:

- **Headless.** The controller has no UI of its own. It exposes state over MQTT
  (telemetry out) and accepts configuration/control over a REST API (the sole
  write path). Visualization is the [Phase 2 frontend](../frontend/01-spec-frontend-overview.md)'s
  job. See [interfaces](./08-spec-controller-interfaces.md).
- **Crop-agnostic.** It knows only numeric setpoints, never a crop. The mapping
  from a crop + growth stage to target values is owned *above* it (the platform,
  or a TOML file when standalone). See
  [config](./07-spec-controller-config-and-parameters.md) and
  [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain).
- **Simulated, not embedded.** The HAL is pure software; there is no real-hardware
  path and nothing runs on a device. Bounded first-order-lag dynamics — not full
  physics — make the control problem non-trivial. See
  [HAL simulation](./03-spec-controller-hal-simulation.md).

What is sensed and actuated (the physical inventory and the coupling between
climate variables) lives in
[`physical-system-single.md`](../physical-system-single.md); this set covers how
the controller *uses* them.

---

## 2. System context

In standalone Phase 1 the controller is observed directly through MQTT tooling and
its REST surface. From Phase 2 on, a platform sits above it; the controller itself
is unchanged.

```
                      ┌──────────────────────────────┐
   observe (MQTT)  ◀──│   Climate Controller (P1)    │
   ──────────────────▶│   this spec set              │── drives ──▶ simulated
   control (REST)     │   fixed-tick pipeline + HAL  │◀── senses ──  greenhouse
                      └──────────────────────────────┘                 (HAL)
                                   ▲   │
                          REST     │   │  MQTT (telemetry, up)
                       (setpoints, │   ▼
                        down)  ┌───────────────┐
                               │  Platform (P2) │  one or more controllers × N
                               └───────────────┘
```

The controller's entire outward contract is two surfaces: **MQTT** for
telemetry-only publish (readings, actuator states, fault events, system state) and
a **REST API** for the only inbound writes (setpoints, thresholds, manual
override, health). It subscribes to **no** command topics —
[setpoints arrive over REST](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain),
never MQTT. The HAL boundary below is load-bearing: the controller sees only
sensor readings, never simulation internals, which is what keeps the HAL swappable
for real hardware later. Both surfaces are detailed in
[interfaces](./08-spec-controller-interfaces.md); the internal pipeline in
[architecture](./02-spec-controller-architecture.md).

---

## 3. Phase context

The same binary serves two deployment modes (`P1-PORT-1`); the control logic does
not change between them. Detail is in
[architecture — deployment](./02-spec-controller-architecture.md#8-deployment).

| Mode | Shape | Configured by |
|---|---|---|
| **Phase 1 (standalone)** | Native binary on Windows (the dev machine) | TOML file + direct REST edits — no platform above it |
| **Phase 2 (managed)** | Docker container, one per greenhouse | TOML mounted at startup; setpoints arrive from the platform over REST |

---

## 4. Reading order

1. **This file** — orientation + cross-spec map.
2. [`02-spec-controller-architecture.md`](./02-spec-controller-architecture.md) — *how
   the pieces connect*: the tick pipeline, real-time model, override, failure
   modes, deployment.
3. [`03-spec-controller-hal-simulation.md`](./03-spec-controller-hal-simulation.md) —
   *the world being controlled*: lag model, coupling, disturbances, determinism.
4. [`04-spec-controller-sensing.md`](./04-spec-controller-sensing.md) — *turning
   readings into trusted values*: fusion, VPD, fault detection.
5. [`05-spec-controller-control-loops.md`](./05-spec-controller-control-loops.md) —
   *the decisions*: the loop hierarchy, algorithms, and dynamics.
6. [`06-spec-controller-safety-and-constraints.md`](./06-spec-controller-safety-and-constraints.md) —
   *the guardrails*: interlocks, priority ordering, actuator constraints.
7. [`07-spec-controller-config-and-parameters.md`](./07-spec-controller-config-and-parameters.md) —
   *the knobs*: TOML schema, scheduling, and the default-parameters reference.
8. [`08-spec-controller-interfaces.md`](./08-spec-controller-interfaces.md) — *the
   outward surfaces*: MQTT + REST and their contract binding.
9. [`09-spec-controller-tech-stack.md`](./09-spec-controller-tech-stack.md) — *what
   each dependency is and why*.
10. [`10-spec-controller-constraints.md`](./10-spec-controller-constraints.md) — *the
    non-negotiable rules* and what is out of scope.

---

## 5. Conventions used across the set

- **Reference, don't redefine.** A wire format owned by `contracts/`, a physical
  fact owned by [`physical-system-single.md`](../physical-system-single.md), a
  quality target owned by the NFR doc, or a decision owned by an RFC is *linked*,
  never restated.
- **NFR IDs** are cited by their stable ID (`P1-PERF-1`, `P1-REL-1`, `P1-REL-4`,
  `P1-RESIL-1`, `P1-RESIL-3`, `P1-OBS-1`, `P1-MOD-1`, `P1-TEST-2`, …) from the
  [NFR doc](../../artifacts/non-functional-requirements.md).
- **Relative links** resolve from `docs/specs/design/controller/`: sibling design
  specs and the physical-system docs at `../`, artifacts at `../../artifacts/`,
  decisions at `../../../decisions/`, repo-root contracts at `../../../../contracts/`.
- **Defaults are illustrative.** Numeric defaults shown inline (time constants,
  gains, thresholds) are consolidated and owned by the
  [default-parameters reference](./07-spec-controller-config-and-parameters.md#default-parameters-reference);
  the TOML file is the runtime source of truth.

---

## 6. Cross-spec map

How this set divides the work, and where each concern is detailed:

| Concern | Owned by | Defers to |
|---|---|---|
| What the controller is; system context; this index | this file | [physical-system](../physical-system-single.md) |
| Tick pipeline, real-time/scheduling model, state topology, manual override, failure modes, deployment | [`02-spec-controller-architecture.md`](./02-spec-controller-architecture.md) | `P1-PERF-*`, `P1-REL-1`, `P1-RESIL-*`, `P1-PORT-1` |
| HAL lag model, coupling matrix, disturbances, determinism, observed actuator state + fault injection, the Phase 4 seam | [`03-spec-controller-hal-simulation.md`](./03-spec-controller-hal-simulation.md) | [physical-system](../physical-system-single.md), [RFC-006](../../../decisions/request-for-comments.md#rfc-006-phase-4-seam-strategy) |
| Sensor fusion, VPD derivation, fault detection, degradation ladder | [`04-spec-controller-sensing.md`](./04-spec-controller-sensing.md) | `P1-REL-2`, `P1-REL-3`, `P1-RESIL-1` |
| Control-loop hierarchy, per-loop algorithms, setpoint resolution, dynamics, saturation | [`05-spec-controller-control-loops.md`](./05-spec-controller-control-loops.md) | — |
| Safety interlocks, priority ordering, actuator constraints, actuator health monitoring | [`06-spec-controller-safety-and-constraints.md`](./06-spec-controller-safety-and-constraints.md) | `P1-REL-1`, `P1-REL-4` |
| TOML config, scheduling, startup-vs-runtime, default parameters | [`07-spec-controller-config-and-parameters.md`](./07-spec-controller-config-and-parameters.md) | [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) |
| MQTT + REST surfaces, contract binding, connection resilience | [`08-spec-controller-interfaces.md`](./08-spec-controller-interfaces.md) | [`contracts/`](../../../../contracts/), [`spec-contracts.md`](../spec-contracts.md), `P1-RESIL-3` |
| Per-dependency choices + rejected alternatives | [`09-spec-controller-tech-stack.md`](./09-spec-controller-tech-stack.md) | [tech-stack-decisions.md](../tech-stack-decisions.md#phase-1--deterministic-greenhouse-controller) |
| Non-negotiable rules; scope / deferred capabilities | [`10-spec-controller-constraints.md`](./10-spec-controller-constraints.md) | [constraints artifact](../../artifacts/constraints.md), [NFR doc](../../artifacts/non-functional-requirements.md) |
| Quality targets (tick rate, jitter, coverage, availability) | [NFR doc](../../artifacts/non-functional-requirements.md) | — (single source) |

If a controller change can't be traced to one of these documents — or to the
contracts / RFCs they reference — it doesn't belong in Phase 1.
