# Platform — Constraints

> **Purpose:** The fixed boundaries the platform is built inside. These are not goals
> or preferences — quality goals live in the
> [NFR doc](../../artifacts/non-functional-requirements.md). Constraints are the
> **non-negotiable rules** imposed by the system's safety model, the phased roadmap,
> and prior decisions (RFCs/ADRs/the
> [constraints artifact](../../artifacts/constraints.md)). If a design choice conflicts
> with anything below, the design choice changes. The last section records what is
> deliberately **out of scope**.

Each entry: the constraint, **why** it exists, and **what it forces or forbids**.

---

## 1. The platform sets targets, never commands actuators

- **Why:** Safety must stay inside the controller; the platform must have no imperative
  path that could drive an unsafe state
  ([crop profiles](./spec-platform-crop-profiles.md#5-fleet-management--operator-control)).
- **Forces:** All downward writes are *setpoints / thresholds* (profile resolution or
  ad-hoc edits) over the controller REST config API.
- **Forbids:** Direct actuator commands; proxying manual actuator overrides; any
  imperative control of greenhouse hardware.

## 2. Single setpoint authority

- **Why:** Exactly one party may write controller setpoints
  ([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)).
- **Forces:** Crop-profile resolution, operator edits, and (Phase 3) the optimizer all
  go through the platform's one setpoint write path with provenance
  ([crop profiles §4](./spec-platform-crop-profiles.md#4-boundary-with-phase-3--single-setpoint-authority)).
- **Forbids:** A second authority writing the controller directly; the optimizer
  bypassing the platform.

## 3. Safety authority stays in the controller

- **Why:** The controller's interlocks hold unconditional priority over any setpoint
  ([controller safety](../controller/spec-controller-safety-and-constraints.md#2-safety-interlocks)).
- **Forces:** The platform to **observe and report** interlock activations.
- **Forbids:** The platform overriding, disabling, or out-prioritizing a controller
  interlock.

## 4. MQTT is telemetry-only; control is REST

- **Why:** Separated transports with separate semantics
  ([RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format),
  [interfaces](./spec-platform-interfaces.md#2-telemetry-only-over-mqtt-all-control-over-rest)).
- **Forces:** Ingestion is read-only w.r.t. the greenhouse; all writes go over the
  controller REST API.
- **Forbids:** MQTT command topics; any downward control over MQTT.

## 5. Local, zero-cloud, single site

- **Why:** The platform is a local PaaS for one site
  ([overview](./spec-platform-overview.md#1-what-the-platform-is),
  [constraints artifact](../../artifacts/constraints.md)).
- **Forces:** The whole stack runs under Docker Compose on one host; identity (Keycloak)
  is self-hosted; per-greenhouse data lives in the registry.
- **Forbids:** Any cloud dependency; modeling multiple sites or tenants.

## 6. Manages, does not couple physics

- **Why:** Each greenhouse is an independent climate and failure domain
  ([physical-system-multi](../physical-system-multi.md#out-of-scope-for-this-site-model)).
- **Forces:** The platform aggregates, stores, and manages per-greenhouse state
  independently.
- **Forbids:** Shared air mass / sensing assumptions; cross-greenhouse orchestration
  that couples their behavior.

---

## 7. Scope — deferred / out-of-scope

Platform capabilities intentionally **not** in Phase 2:

| Deferred / excluded | Why / where it belongs |
|---|---|
| AI optimization & **setpoint refinement** | Dynamic, anticipatory, cost-aware tuning of the crop-profile baseline — **Phase 3**. Phase 2 owns only the static crop → targets mapping ([crop profiles](./spec-platform-crop-profiles.md)) |
| Weather / forecast feed | Live + forecast outdoor conditions and weather-reactive control — **Phase 4** (stretch goal); see [physical-system-multi.md](../physical-system-multi.md#weather-forecast) |
| Site-wide orchestration | Coordinated behavior across greenhouses (e.g. staggering loads) needs the shared-infrastructure / resource-contention model that is [out of scope for the site](../physical-system-multi.md#common-inputs--out-of-scope). Phase 2 aggregates and manages; it does not couple physics |
| Multi-site / multi-tenant | The platform manages a **single site**; multiple sites or tenants are not modeled |
| Advanced RBAC | Two roles (viewer/operator) only; fine-grained permissions and org hierarchies are out of scope ([security](./spec-platform-security.md)) |
| Manual actuator override | Forcing individual actuators is a **controller-local** action ([controller architecture](../controller/spec-controller-architecture.md#6-manual-override)); the platform's downward control is **setpoint-only** and does not proxy actuator overrides |
| Safety authority | Safety interlocks remain **controller-owned** ([§3](#3-safety-authority-stays-in-the-controller)); the platform never overrides them |

---

## 8. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| The setpoint-only / single-authority write path these rules bound | constrains | [`spec-platform-crop-profiles.md`](./spec-platform-crop-profiles.md) |
| The telemetry-only / control-REST split | constrains | [`spec-platform-interfaces.md`](./spec-platform-interfaces.md) |
| Setpoint authority + delivery chain | defers to | [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) |
| Internal trust boundary | defers to | [RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries) |
| System-wide constraint inventory | mirrors | [constraints artifact](../../artifacts/constraints.md) |
| Quality targets (not constraints) | separate from | [NFR doc](../../artifacts/non-functional-requirements.md) |
