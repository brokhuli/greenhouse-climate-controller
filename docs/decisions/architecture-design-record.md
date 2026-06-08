# Architecture Design Record

A running log of significant architectural decisions and their rationale. Newest entries at the top.
Each entry corresponds to an accepted RFC in [`request-for-comments.md`](./request-for-comments.md).

---

## 2026-06-07 — Contract conventions: topic taxonomy, identity, payload envelope, JSON Schema

**Decision:** Fix the conventions that govern `contracts/` before any schema file is written.
(1) **Identity** — a single `greenhouse_id` / `zone_id` pair, both lowercase kebab slugs, used
verbatim as the keys in MQTT topics, REST paths, and DB rows (no UUIDs, no translation layer).
(2) **MQTT topic taxonomy** — hierarchical `gh/{greenhouse_id}/...` with a greenhouse- vs zone-scoped
split mirroring the physical model; QoS 1 on all telemetry; retained only on the consolidated
`gh/{id}/state` topic. MQTT is **telemetry-only** — the controller subscribes to nothing and there
are no command/plan topics. (3) **Payload envelope** — every message carries `schema_version`,
`greenhouse_id`, `zone_id`, and `ts` (RFC 3339 UTC, ms precision), plus a fixed units convention
(°C, %RH, ppm, %VWC, µmol·m⁻²·s⁻¹, kPa). (4) **Schema format & versioning** — JSON Schema
(Draft 2020-12) is the normative artifact, one file per message type under `contracts/mqtt/`;
`schema_version` is an integer major, additive/backward-compatible changes do not bump it, breaking
changes bump and run side-by-side during transition. Each contract change carries an ADR.

**Why:** `contracts/` is the single artifact all three phases (Rust, Go, Python) conform to, yet RFCs
001–006 each settled a *component* and none designed the wire contract itself — the highest-blast
-radius decision in the system, since changing it later means editing three codebases at once. The
specs uniformly defer wire formats to `contracts/`, so these conventions had to be decided before the
first schema. Slugs over UUIDs because the system is local and single-site and the controllers are
named, config-generated services (RFC-003) — readable in topics, logs, and the MQTT tree. JSON Schema
over AsyncAPI because validation is needed in all three stacks with no intermediate tooling; AsyncAPI
can wrap it later as docs. A common envelope lets a multi-greenhouse ingester attribute and validate
each message independently. The decision also resolves a standing doc inconsistency: post-RFC-005 the
controller is setpoint-only with setpoints over REST, so MQTT is telemetry-only — the stale
"actuator command/plan over MQTT" references in `contracts/README.md`, `high-level-idea.md`, and
`spec-climate-controller.md §11` are corrected to match.

**RFC:** [RFC-007](./request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)

---

## 2026-06-07 — Phase 4 seam: HAL actuator interface must not assume one actuator → one variable

**Decision:** Implement Phases 1–3 exactly as specified, with a single forward-looking constraint on
the Phase 1 HAL: the actuator interface (trait) must model an actuator as producing a *set of effects
on climate variables*, not a one-to-one actuator→variable mapping. The existing simulated actuators
each happen to affect mostly one variable, but the interface must not encode that as an invariant.
Nothing else is built ahead of Phase 4 — no combustion-heater implementation (not even behind a
flag), no weather/forecast ingestion, and no actuator-selection coordination layer above the PIDs.

**Why:** Phase 4's combustion heater is one device that raises temperature, CO₂, and humidity at
once, breaking the independent-loop assumption. If the HAL trait hard-codes one actuator → one
variable, adding the burner in Phase 4 forces a HAL rewrite; shaping the trait correctly now makes
the burner a new HAL backend implementing the same trait — additive, not a rewrite. The constraint
is zero-cost and provably contained: the actuator→variable coupling already lives in the HAL
simulation's coupling matrix, not in the control loops (the PIDs target variables, not actuators), so
it does not bleed Phase 4 complexity into the rule engine or PID wiring. Building anything more ahead
of Phase 4 (combustion logic, weather feeds, coordination) was rejected as premature — it would raise
the complexity of layers that should stay at their Phase 1–3 ratings until Phase 4 is actually in
scope.

**RFC:** [RFC-006](./request-for-comments.md#rfc-006-phase-4-seam-strategy)

---

## 2026-06-07 — Setpoint authority: Phase 2 is the single authority

**Decision:** Phase 2 is the single authority for controller setpoints. Every setpoint source — crop
-profile assignment, operator override, and the Phase 3 optimizer — writes through the Phase 2
setpoint API. Phase 2 enforces crop-safe bounds, records provenance (source = `crop_profile`,
`optimizer`, or `manual_override`, with timestamp and value), and is the sole delivery path to the
Phase 1 controller via the controller's REST config API. The optimizer submits refined targets via
`POST /greenhouses/{id}/setpoints` (with an `optimizer_run_id` for tracing) and never writes to the
controller directly or over MQTT.

**Why:** Phase 2 already holds the crop-safe bounds (from crop profiles) and is the source of truth
for intended state. Routing every setpoint source through it keeps bounds enforcement and provenance
in one place, rather than re-implementing validation in the optimizer and splitting the audit trail
across systems. The alternatives — optimizer publishing over MQTT or calling the Phase 1 REST API
directly — each create a second setpoint authority and a direct Phase 3 → Phase 1 dependency the
layer separation is designed to prevent. The latency cost of the extra hop is irrelevant: setpoint
changes are minutes-scale (the optimizer's planning cadence, per RFC-004), not real-time actuator
commands.

**RFC:** [RFC-005](./request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)

---

## 2026-06-07 — Phase 3 LLM integration: hosted primary, Ollama fallback, backend-agnostic strategy

**Decision:** Use a hosted LLM (Anthropic or OpenAI) as the primary planning backend, with Ollama
as the local fallback when the hosted backend is unreachable or unconfigured. Both backends
implement a `PlannerBackend` protocol; the planning loop is identical regardless of which is active.
A single backend-agnostic invocation strategy — fixed token budget (4 000 tokens), hourly telemetry
summaries, 12-hour adaptive horizon, state-change gate (5% deviation threshold), and 30-minute
cycle cadence — is applied in the serialization layer before any backend call.

**Why:** Hosted frontier models produce more reliably constraint-valid multi-variable plans than
7B–13B local models. Docker Desktop containers have outbound internet access by default, so the
network dependency is low friction. The Ollama fallback preserves planning continuity during
transient hosted-backend outages without requiring a code change. The backend-agnostic invocation
strategy is necessary because local models have small context windows (4K–8K tokens) and slow
inference, while hosted models have per-token cost — a single conservative budget sized for the
local model addresses both concerns simultaneously, with no per-backend branching in the optimizer.

**RFC:** [RFC-004](./request-for-comments.md#rfc-004-phase-3-llm-integration-interface)

---

## 2026-06-07 — Phase 2 ingress: single nginx (SPA server + reverse proxy)

**Decision:** Use one nginx container as the platform's single entry point — it serves the built
React SPA and reverse-proxies `/api` and `/auth` to the Go API and Keycloak. Traefik is not used.

**Why:** The routing map is static — the platform services and the generated controllers are named,
config-driven Compose services (controllers are generated as named services, not
`docker compose --scale` replicas). Traefik's core advantage is runtime service discovery, which
brings no benefit when there is nothing to dynamically discover. nginx already serves the SPA
regardless, so folding the `/api` and `/auth` proxy rules into that same container adds one config
file and no new component. Static `proxy_pass` upstreams are exactly nginx's strength when the
service map does not churn. A single entry point also keeps OIDC redirect URIs stable. Local TLS,
if needed later, terminates at this same nginx as a config addition.

**RFC:** [RFC-003](./request-for-comments.md#rfc-003-phase-2-platform-ingress)

---

## 2026-06-07 — Phase 2 store: TimescaleDB from day one

**Decision:** Use TimescaleDB (the PostgreSQL extension) as Phase 2's single store from the first
migration. Relational metadata (greenhouse registry, crop profiles) lives in ordinary tables; the
high-volume telemetry tables (`sensor_readings`, `actuator_events`) are created as hypertables in
the initial migration, with retention/compression policies applied from the start.

**Why:** The telemetry workload is unambiguously time-series, so the adoption question is *when*,
not *whether*. Because TimescaleDB is a Postgres extension — not a separate database — it serves the
relational metadata with stock PostgreSQL semantics in the same instance, and relational tables and
hypertables coexist and join normally. Committing on day one removes a later image-swap +
`create_hypertable` + policy cutover and gives correct telemetry physical layout (time-range
chunking, retention) from the first insert.

**RFC:** [RFC-002](./request-for-comments.md#rfc-002-phase-2-persistence-layer)

---

## 2026-06-07 — MQTT broker: Mosquitto

**Decision:** Use Mosquitto as the MQTT broker for all phases.

**Why:** The required feature set is QoS + retained messages, which Mosquitto covers with the
smallest footprint and simplest configuration. The system is single-site and local-only — EMQX's
dashboard, clustering, and per-client ACLs provide no benefit at this scale. The abstraction is
pure MQTT, so swapping to EMQX later is a Compose and config change, not a code change.

**RFC:** [RFC-001](./request-for-comments.md#rfc-001-mqtt-broker-selection)
