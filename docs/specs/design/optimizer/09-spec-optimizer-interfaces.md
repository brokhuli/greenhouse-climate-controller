# Optimizer — Interfaces & Integration

> **Purpose:** Enumerate the optimizer's outward surfaces — the read-only TimescaleDB
> view path in, the Phase 2 setpoint REST API out, and the served FastAPI operator
> surface — and the discipline that all downward influence flows **through Phase 2**,
> never straight to a controller.

Part of the [optimizer set](./01-spec-optimizer-overview.md); wire formats are owned by
[`contracts/`](../../../../contracts/) and catalogued in
[`spec-contracts.md`](../spec-contracts.md) — this file lists *responsibilities*, not
schemas.

---

| Interface | Direction | Role |
|---|---|---|
| **TimescaleDB** | Phase 2 store → optimizer | Read-only historical telemetry, actuator states, and current setpoints for one greenhouse. Per [RFC-008](../../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path): connects as the dedicated `optimizer_ro` role with `SELECT`-only grants on a small set of named telemetry **views** (not the raw hypertables), which are a versioned read-surface contract. |
| **Phase 2 REST API** | Optimizer → platform | Write refined setpoint bundles (layered on the crop baseline); platform reconciles to the controller |
| **Service API (FastAPI)** | Operator/tools → optimizer | Trigger planning cycles, inspect proposed plans, review and act on escalations |

The optimizer **consumes** the contracts owned by [`contracts/`](../../../../contracts/) and the Phase 2
interfaces ([P2 crop profiles](../platform/spec-platform-crop-profiles.md),
[P2 interfaces](../platform/spec-platform-interfaces.md)) rather than defining new
ones. It does **not** open its own channel to the Phase 1 controller — all downward influence flows
through Phase 2, preserving the platform's authority over intended state.
