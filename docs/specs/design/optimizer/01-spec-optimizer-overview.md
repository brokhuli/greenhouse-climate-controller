# Optimizer Spec — Overview & Index

> **Purpose:** This is the entry point and anchor for the **Phase 3 greenhouse
> climate optimizer** spec set. It says what the optimizer is, how it fits the
> phased system, how it connects to everything around it, and — via the
> [cross-spec map](#4-cross-spec-map) — which document owns which concern. Read
> this file first; read the others for detail.

This set is the **top-level design spec for Phase 3**: the **intelligence layer**
that sits above each greenhouse's deterministic Phase 1 controller and refines the
climate targets Phase 2 resolves from crop profiles. It describes the **software
service**. It sits alongside the
[controller](../controller/01-spec-controller-overview.md),
[platform](../platform/01-spec-platform-overview.md), and [Phase 4](../spec-phase4.md)
specs, one altitude **above** the wire contracts in
[`contracts/`](../../../../contracts/). For the physical system whose dynamics it
simulates — the sensors, actuators, and the coupling between climate variables — see
[`physical-system-single.md`](../physical-system-single.md); for the controller it
ultimately steers, see
[`01-spec-controller-overview.md`](../controller/01-spec-controller-overview.md); for the
platform it integrates with, see
[`01-spec-platform-overview.md`](../platform/01-spec-platform-overview.md).

> Scope note: this is an architectural spec (components, responsibilities, behavior,
> configuration). Concrete code/module/class design is deferred until implementation.
> Wire formats, identity, and payload conventions are **referenced, not redefined** —
> see [spec conventions](../spec-conventions.md) and the full contract catalog in
> [`spec-contracts.md`](../spec-contracts.md).

---

## 1. What the optimizer is

Phase 3 is a **local Python service** that optimizes one greenhouse's climate by *thinking ahead*.
The Phase 1 controller is **reactive and crop-agnostic** — it regulates to whatever setpoints it is
given. Phase 2 supplies those setpoints as a **static** crop→targets baseline ("lettuce, fruiting →
these VPD / DLI / CO₂ / temperature targets"). Neither layer anticipates: the controller corrects
error after it appears, and the baseline does not move with the time of day or a cost signal.

Phase 3 closes that gap. It pulls a greenhouse's history, **simulates its climate forward**, uses an
LLM to propose a refined plan, **validates that plan against crop-safe and physical constraints**,
and pushes the refined targets down — pre-positioning for the known diurnal cycle, coordinating
coupled actuators, and trimming energy cost, all **within the crop-safe bounds Phase 2's profile
defines**. It optimizes setpoint *management*; it does not introduce the crop→targets mapping (that
is Phase 2's) and it does not command actuators directly (that is Phase 1's).

The optimizer is the intelligence layer above **each** greenhouse's controller. It operates on **one
greenhouse at a time** — N independent planning problems, mirroring the N independent control loops
of Phase 1. Site-wide orchestration across greenhouses, weather-reactive control, and combustion-heater
coordination are out of scope (see [scope](./11-spec-optimizer-scope.md)).

---

## 2. Reading order

1. **This file** — orientation + cross-spec map.
2. [`02-spec-optimizer-architecture.md`](./02-spec-optimizer-architecture.md) — *how
   the pieces connect*: the per-greenhouse planning cycle, the components, and the
   read → plan → apply data flow.
3. [`03-spec-optimizer-digital-twin.md`](./03-spec-optimizer-digital-twin.md) — *the
   world it predicts*: the forward climate model, plus its numerical robustness and
   parameter-drift detection.
4. [`04-spec-optimizer-planning.md`](./04-spec-optimizer-planning.md) — *the
   decisions*: the LLM planner chain, invocation strategy, determinism, and the
   optimization objectives it plans against.
5. [`05-spec-optimizer-constraints-and-application.md`](./05-spec-optimizer-constraints-and-application.md) —
   *the guardrails on output*: the constraint engine, the auto-apply / escalation
   gate, and write-path concurrency & reconciliation.
6. [`06-spec-optimizer-input-gating.md`](./06-spec-optimizer-input-gating.md) — *the
   guardrail on input*: the data-quality / freshness precondition run before planning.
7. [`07-spec-optimizer-evaluation.md`](./07-spec-optimizer-evaluation.md) — *holding
   quality stable*: the regression-testing strategy around the planner and twin.
8. [`08-spec-optimizer-resilience.md`](./08-spec-optimizer-resilience.md) — *running
   it*: stateless restart, config validation, escalation backpressure, the watchdog.
9. [`09-spec-optimizer-interfaces.md`](./09-spec-optimizer-interfaces.md) — *the
   outward surfaces*: the three integration interfaces and the served FastAPI API.
10. [`10-spec-optimizer-configuration.md`](./10-spec-optimizer-configuration.md) —
    *the knobs*: the service configuration keys.
11. [`11-spec-optimizer-scope.md`](./11-spec-optimizer-scope.md) — *the boundary*:
    deferred / out-of-scope capabilities.

---

## 3. Conventions used across the set

- **Reference, don't redefine** — the shared rule and its sources of truth live in
  [spec conventions](../spec-conventions.md).
- **NFR IDs** are cited by their stable ID (`P3-MOD-1`, `P3-OBS-1`, `P3-PERF-2`,
  `P3-SCAL-1`, `P3-RESIL-1`, `P3-REL-1`, `P3-TEST-1`, `P3-AVAIL-1`, …) from the
  [NFR doc](../../artifacts/non-functional-requirements.md).
- **Relative links** resolve from `docs/specs/design/optimizer/`: sibling design
  specs and the physical-system docs at `../`, the controller/platform/frontend sets
  at `../controller/`, `../platform/`, and `../frontend/`, artifacts at
  `../../artifacts/`, decisions at `../../../decisions/`, repo-root contracts at
  `../../../../contracts/`.

---

## 4. Cross-spec map

How this set divides the work, and where each concern is detailed:

| Concern | Owned by | Defers to |
|---|---|---|
| What the optimizer is; system role; this index | this file | [physical-system](../physical-system-single.md) |
| The per-greenhouse planning cycle, components, and data flow | [`02-spec-optimizer-architecture.md`](./02-spec-optimizer-architecture.md) | — |
| Forward climate model; numerical robustness + parameter-drift detection | [`03-spec-optimizer-digital-twin.md`](./03-spec-optimizer-digital-twin.md) | [physical-system](../physical-system-single.md) |
| LLM planner (chain, invocation strategy, determinism) + optimization objectives | [`04-spec-optimizer-planning.md`](./04-spec-optimizer-planning.md) | [RFC-004](../../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface) |
| Constraint engine, application gate, write-path concurrency & reconciliation | [`05-spec-optimizer-constraints-and-application.md`](./05-spec-optimizer-constraints-and-application.md) | [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) |
| Input data-quality / freshness gating before planning | [`06-spec-optimizer-input-gating.md`](./06-spec-optimizer-input-gating.md) | [RFC-008](../../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path) |
| Evaluation & regression-testing strategy | [`07-spec-optimizer-evaluation.md`](./07-spec-optimizer-evaluation.md) | [NFR doc](../../artifacts/non-functional-requirements.md) |
| Service resilience, stateless restart, escalation backpressure, watchdog | [`08-spec-optimizer-resilience.md`](./08-spec-optimizer-resilience.md) | — |
| The three integration interfaces + the served FastAPI surface | [`09-spec-optimizer-interfaces.md`](./09-spec-optimizer-interfaces.md) | [`contracts/`](../../../../contracts/), [`spec-contracts.md`](../spec-contracts.md), [RFC-008](../../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path) |
| Service configuration (env / Compose) and its keys | [`10-spec-optimizer-configuration.md`](./10-spec-optimizer-configuration.md) | — |
| Non-negotiable scope; deferred / out-of-scope capabilities | [`11-spec-optimizer-scope.md`](./11-spec-optimizer-scope.md) | [spec-phase4.md](../spec-phase4.md) |
| Verification & feedback loops (system-wide strategy, tooling, CI; `07` is this set's instance) | [`spec-verification.md`](../spec-verification.md) | [NFR doc](../../artifacts/non-functional-requirements.md) |
| Quality targets (perf, scale, reliability, test) | [NFR doc](../../artifacts/non-functional-requirements.md) | — (single source) |

If a Phase 3 change can't be traced to one of these documents — or to the contracts /
RFCs they reference — it doesn't belong in the optimizer.
