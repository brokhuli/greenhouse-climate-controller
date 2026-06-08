# Architecture Design Record

A running log of significant architectural decisions and their rationale. Newest entries at the top.
Each entry corresponds to an accepted RFC in [`request-for-comments.md`](./request-for-comments.md).

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
