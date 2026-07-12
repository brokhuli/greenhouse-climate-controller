# Optimizer — Interfaces & Integration

> **Purpose:** Enumerate the optimizer's outward surfaces — the Phase 2 REST telemetry
> read path in, the Phase 2 setpoint REST API out, and the served FastAPI operator
> surface — and the discipline that all downward influence flows **through Phase 2**,
> never straight to a controller.

Part of the [optimizer set](./01-spec-optimizer-overview.md); wire formats are owned by
[`contracts/`](../../../../contracts/) and catalogued in
[`spec-contracts.md`](../spec-contracts.md) — this file lists *responsibilities*, not
schemas.

---

| Interface | Direction | Role |
|---|---|---|
| **Phase 2 REST API (read)** | Platform → optimizer | Read-only planning context for one greenhouse: historical telemetry, actuator states, current setpoints, and data-quality/freshness signals. Per the revised [RFC-008](../../../decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path), this is a REST contract; the platform may back it with internal SQL views or continuous aggregates, but the optimizer never connects to TimescaleDB directly. |
| **Phase 2 REST API (write)** | Optimizer → platform | Write refined setpoint bundles (layered on the crop baseline); platform reconciles to the controller |
| **Service API (FastAPI)** | Operator/tools → optimizer | Trigger planning cycles, inspect proposed plans, review and act on escalations |
| **`/metrics` (Prometheus)** | Prometheus → optimizer | Operational *optimizer-health* scrape served on the FastAPI service — an unauthenticated read, **outside** the versioned contracts, the metrics sibling of `/health`. Joins the platform's shared Prometheus/Grafana ([platform operations §1](../platform/08-spec-platform-operations.md#1-observability), [tech stack §Observability](./12-spec-optimizer-tech-stack.md#observability)) |

The optimizer **consumes** the contracts owned by [`contracts/`](../../../../contracts/) and the Phase 2
interfaces ([P2 crop profiles](../platform/05-spec-platform-crop-profiles.md),
[P2 interfaces](../platform/09-spec-platform-interfaces.md)) rather than defining new
ones. It does **not** open its own channel to the Phase 1 controller — all downward influence flows
through Phase 2, preserving the platform's authority over intended state.

### Service API endpoints

The operator/tools surface (the **Service API (FastAPI)** row above) exposes the endpoints below. This
lists **names and intent**; concrete request/response schemas are deferred to implementation (per the
[overview](./01-spec-optimizer-overview.md) scope note). Unlike the Phase 2 read/write contracts in
[`contracts/`](../../../../contracts/), this is the optimizer's **own internal surface**, not a
versioned wire contract.

| Method + path | Purpose |
|---|---|
| `GET /health` | Liveness/readiness — Phase 2 reachability, LLM backend reachability, last-successful-cycle time, escalation backlog ([resilience — watchdog](./09-spec-optimizer-resilience.md)) |
| `GET /metrics` | Prometheus optimizer-health scrape (the `/metrics` row above) |
| `POST /api/optimizer/greenhouses/{id}/cycles` | Trigger a planning cycle for one greenhouse, out of band from the fixed cadence |
| `GET /api/optimizer/greenhouses/{id}/plans/latest` | Inspect the latest proposed / applied plan for one greenhouse |
| `GET /api/optimizer/escalations` | List open escalations (held cycles awaiting operator review) |
| `POST /api/optimizer/escalations/{id}/resolve` | Act on / clear an escalation |

Every plan and escalation these endpoints expose is traced by `optimizer_run_id`
([P3-OBS-1](../../artifacts/non-functional-requirements.md)); each escalation carries a
[reason code](#escalation-reason-codes).

### Escalation reason codes

Every escalation — from the
[application gate](./06-spec-optimizer-constraints-and-application.md#2-setpoint-refinement--application),
[input gating](./07-spec-optimizer-input-gating.md),
[twin robustness](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity),
the [write path](./06-spec-optimizer-constraints-and-application.md#3-write-path-concurrency--reconciliation),
or [resilience](./09-spec-optimizer-resilience.md) — carries a canonical **reason code**, so operators
and dashboards classify held cycles without parsing prose. This table is the single source of truth; the
raising gates reference it rather than re-listing codes.

| Code | Raised by | Class |
|---|---|---|
| `input_stale` | input gating — freshness miss | transient |
| `input_incomplete` | input gating — completeness miss | transient |
| `sensor_fault` | input gating — sensor health (faulted / degraded) | transient |
| `actuator_fault` | input gating — actuator health (`stuck` / `no_response`) | transient |
| `clock_mode_unsupported` | input gating — `time_scale ≠ 1.0` | transient |
| `contract_drift` | input gating — identity / `schema_version` mismatch | persistent |
| `twin_diverged` | twin — numerical divergence (non-finite / non-converging step) | transient |
| `twin_fidelity_fault` | twin — sustained parameter drift | persistent |
| `constraint_violation` | constraint engine — target out of crop-safe range, or an inconsistent setpoint bundle | persistent (for this plan) |
| `low_confidence` | application gate — plan below the confidence threshold | transient |
| `bounds_mismatch` | write path — Phase 2 `422` disagreement with local bounds | persistent |
| `cycle_timeout` | resilience — cycle overran `cycle_timeout_seconds` | transient |
| `llm_unavailable` | planner — backend unreachable and no fallback configured | transient |

**Class** is the operator-triage hint the input gate already draws
([input gating](./07-spec-optimizer-input-gating.md)): a **transient** code may clear on the next cycle
once inputs, the twin, the clock, or the backend recover; a **persistent** code is a deployment,
contract, model, or bounds fault that will **not** self-heal and needs an operator fix or recalibration.
All are **surfaced, not applied** — the Phase 2 baseline stays in force regardless
([P3-RESIL-1](../../artifacts/non-functional-requirements.md)).

### Authenticating the Phase 2 write path

By default the Phase 2 REST write is **trusted on the local Docker network** and carries no credential.
Per [RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009),
when the platform runs with `SERVICE_AUTH_MODE=oidc` (the cloud / multi-host posture) the optimizer
authenticates as a **Keycloak confidential client** (`client_id: optimizer`) via the **client-credentials**
grant and presents the resulting token as a `Bearer` credential on `POST /api/greenhouses/{id}/setpoints`.
The token carries a **narrow `setpoints:write` service role** — not the operator role — so a compromised
credential can do nothing but propose in-bounds setpoints, which Phase 2 re-validates regardless. The
client secret and the `SERVICE_AUTH_MODE` the optimizer targets are
[configuration](./11-spec-optimizer-configuration.md), never committed; the setpoint contract itself is
**identical** with or without the token. This is the optimizer half of the deferred service-auth seam —
dormant in the single-host local deployment, enabled by configuration alone.
