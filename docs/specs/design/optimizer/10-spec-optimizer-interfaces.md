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
| **Service API (FastAPI)** | Operator/tools → optimizer | Trigger on-demand planning cycles, select the active allowlisted model, inspect proposed plans, review and act on escalations |
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
| `GET /health` | Liveness/readiness — Phase 2 reachability, LLM backend reachability, last-successful-cycle time, escalation backlog, and whether planning is **enabled** or the service is in read-only mode ([resilience — watchdog](./09-spec-optimizer-resilience.md)) |
| `GET /metrics` | Prometheus optimizer-health scrape (the `/metrics` row above) |
| `POST /api/optimizer/greenhouses/{id}/cycles` | Operator-gated: trigger an **on-demand** planning cycle for one greenhouse, out of band from the fixed cadence (body `{ reason? }`). The request asks for a fresh plan, so it bypasses state-change suppression but not input/safety/application gates; `409` while the optimizer is **disabled** (read-only — [resilience](./09-spec-optimizer-resilience.md)) or that greenhouse already has a cycle in flight |
| `GET /api/optimizer/greenhouses/{id}/plans/latest` | Inspect the latest proposed / applied plan for one greenhouse |
| `GET /api/optimizer/escalations` | List **open** escalations (held cycles awaiting operator review); see the escalation-lifecycle note below |
| `POST /api/optimizer/escalations/{id}/resolve` | Operator-gated: resolve an open escalation (the `operator` resolution). Open escalations also close **automatically** as `superseded` or `expired` ([resilience](./09-spec-optimizer-resilience.md)) |
| `GET /api/optimizer/model` | Inspect the active backend (`provider`, `model`, `prompt_version`, `role`) and the active provider's runtime `available_models` allowlist ([configuration](./11-spec-optimizer-configuration.md)) |
| `POST /api/optimizer/model` | Operator-gated: switch the active **`model`** within the active provider's allowlist (body `{ model, reason? }`). Takes effect on the **next** cycle; `400` if the model is not in `available_models[provider]`, `401` / `403` in `oidc` mode without the operator role. The **`provider`** is *not* changeable here — a provider change is an offline config change ([auth](#authenticating-the-model-change-endpoint)) |
| `GET /api/optimizer/enabled` | Inspect whether planning is **enabled** or the service is in read-only mode |
| `POST /api/optimizer/enabled` | Operator-gated: enable or disable the optimizer at runtime (body `{ enabled, reason? }`). Disabling drops the service into **read-only mode** — no scheduled cycles, no setpoint writes, reads still served ([resilience](./09-spec-optimizer-resilience.md)); takes effect immediately and is **in-memory**, resetting to the configured default on restart. `401` / `403` in `oidc` mode without the operator role ([auth](#authenticating-the-enable-disable-endpoint)) |

Every plan and escalation these endpoints expose is traced by `optimizer_run_id`
([P3-OBS-1](../../artifacts/non-functional-requirements.md)) and stamped with the `backend` that
produced it — provider, `model`, and the pinned
[`prompt_version`](./04-spec-optimizer-planning.md#prompt-template--versioning)
([plan contract §3](./05-spec-optimizer-plan-contract.md#3-planrecord--the-optimizer-service-envelope)) —
so a returned plan is traceable to its exact `(model, prompt_version)` provenance; each escalation
carries a [reason code](#escalation-reason-codes).

### Escalation lifecycle

`GET /api/optimizer/escalations` returns the **open** set — held cycles still awaiting review. An open
escalation is **closed** either by an operator (`POST …/escalations/{id}/resolve`, the `operator`
resolution) or **automatically**: `superseded` when a newer cycle for the same greenhouse produces a fresh
outcome, or `expired` when it is neither acted on nor re-raised within the configured TTL. This
**resolution** — *how* it closed — is a field distinct from the raise-time [reason code](#escalation-reason-codes)
below — *why* it was raised. The standing-escalation deduplication, the periodic sweep that applies TTL
expiry, and the retention window that then prunes closed escalations (keeping the latest plan per
greenhouse) all live in
[resilience — escalation lifecycle & backpressure](./09-spec-optimizer-resilience.md), so an escalated plan
an operator never acts on does not accumulate unbounded.

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
| `contract_drift` | input gating — identity / `schema_version` mismatch; write path — Phase 2 `404` (greenhouse not in the platform registry) | persistent |
| `twin_diverged` | twin — numerical divergence (non-finite / out-of-envelope step) | transient |
| `twin_fidelity_fault` | twin — sustained parameter drift | persistent |
| `constraint_violation` | constraint engine — target out of crop-safe range, or an inconsistent setpoint bundle | persistent (for this plan) |
| `low_confidence` | application gate — plan below the confidence threshold | transient |
| `bounds_mismatch` | write path — Phase 2 `422` disagreement with local bounds | persistent |
| `write_unauthorized` | write path — Phase 2 `401` / `403` (missing/invalid token or absent `setpoints:write` role, `SERVICE_AUTH_MODE=oidc`) | persistent |
| `platform_unavailable` | read / write path — Phase 2 REST unreachable (transport failure / timeout / 5xx gateway) | transient |
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

### Authenticating the manual-cycle endpoint

`POST /api/optimizer/greenhouses/{id}/cycles` (run an on-demand optimizer cycle for one greenhouse) is an
**operator write**, gated like escalation resolution and model selection — **not** the service-auth seam
above. In `oidc` mode the caller must present a Keycloak token carrying the **operator role**; by default
(`trusted_network`) the call is untokened like the rest of the single-host local surface. The request is
structured-logged with the operator identity, greenhouse id, supplied `reason`, and resulting
`optimizer_run_id`. Manual cycles use the same single-flight and safety gates as scheduled cycles: a request
is refused if the optimizer is disabled or that greenhouse is already planning, and a plan can still be held
or escalated rather than applied.

### Authenticating the model-change endpoint

`POST /api/optimizer/model` (switch the active planning `model` at runtime) is an **operator write**, gated
like the other mutating operator endpoints (`POST …/cycles`, `POST …/escalations/{id}/resolve`) — **not**
the service-auth seam above. Choosing the planning model is an **operator decision**, so in `oidc` mode the
caller must present a Keycloak token carrying the **operator role**, *not* the narrow service
`setpoints:write` role the Phase 2 write path uses. By default (`trusted_network`) the call is untokened,
like the rest of the single-host local surface. Either way the change is **structured-logged with the
operator's identity and the supplied `reason`**, and the resulting model is stamped into every subsequent
`PlanRecord.backend.model` and traced by `optimizer_run_id` (`P3-OBS-1`) — so who changed the model, when,
and which plans each model produced are all recoverable. Two guard rails bound the action: the operator may
only select among the pre-vetted [`available_models`](./11-spec-optimizer-configuration.md) for the **active
provider** (expanding that allowlist is an offline, baseline-capturing change —
[evaluation §3](./08-spec-optimizer-evaluation.md)), and the `provider` itself cannot be changed here — a
provider change stays an offline config/Compose change, a reviewed
[ADR event](../../../decisions/architecture-design-record.md). The active model is an **in-memory override
that resets to the configured [`model`](./11-spec-optimizer-configuration.md) on restart**; the config value
remains the default and source of truth.

### Authenticating the enable-disable endpoint

`POST /api/optimizer/enabled` (pause or resume the optimizer at runtime) is an **operator write**, gated
exactly like `POST /api/optimizer/model` above — **not** the service-auth seam. Enabling or disabling
planning is an **operator decision**, so in `oidc` mode the caller must present a Keycloak token carrying the
**operator role**, not the narrow `setpoints:write` service role the Phase 2 write path uses; by default
(`trusted_network`) the call is untokened, like the rest of the single-host local surface. Either way the
change is **structured-logged with the operator's identity and the supplied `reason`**, so who paused or
resumed the optimizer, and when, is recoverable. The flag is an **in-memory override that resets to the
configured [`enabled`](./11-spec-optimizer-configuration.md) default on restart** — a disable is an
operational pause, not a persisted state change. Disabling takes effect **immediately**: the scheduler stops
dispatching new cycles and the applier goes inert, so no setpoint write leaves the service while it is
disabled, and an out-of-band [`POST …/cycles`](#service-api-endpoints) is refused with `409`.
