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
| **`/metrics` (Prometheus)** | Prometheus → optimizer | Operational *optimizer-health* scrape served on the FastAPI service — an unauthenticated read, **outside** the versioned contracts, the metrics sibling of `/health`. Joins the platform's shared Prometheus/Grafana ([platform operations §1](../platform/08-spec-platform-operations.md#1-observability), [tech stack §Observability](./11-spec-optimizer-tech-stack.md#observability)) |

The optimizer **consumes** the contracts owned by [`contracts/`](../../../../contracts/) and the Phase 2
interfaces ([P2 crop profiles](../platform/05-spec-platform-crop-profiles.md),
[P2 interfaces](../platform/09-spec-platform-interfaces.md)) rather than defining new
ones. It does **not** open its own channel to the Phase 1 controller — all downward influence flows
through Phase 2, preserving the platform's authority over intended state.

### Authenticating the Phase 2 write path

By default the Phase 2 REST write is **trusted on the local Docker network** and carries no credential.
Per [RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009),
when the platform runs with `SERVICE_AUTH_MODE=oidc` (the cloud / multi-host posture) the optimizer
authenticates as a **Keycloak confidential client** (`client_id: optimizer`) via the **client-credentials**
grant and presents the resulting token as a `Bearer` credential on `POST /greenhouses/{id}/setpoints`.
The token carries a **narrow `setpoints:write` service role** — not the operator role — so a compromised
credential can do nothing but propose in-bounds setpoints, which Phase 2 re-validates regardless. The
client secret and the `SERVICE_AUTH_MODE` the optimizer targets are
[configuration](./10-spec-optimizer-configuration.md), never committed; the setpoint contract itself is
**identical** with or without the token. This is the optimizer half of the deferred service-auth seam —
dormant in the single-host local deployment, enabled by configuration alone.
