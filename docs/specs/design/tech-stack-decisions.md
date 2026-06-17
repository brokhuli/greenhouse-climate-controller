# Tech Stack Decisions

---

## Phase 1 — Deterministic Greenhouse Controller

**Goal:** Real-time, safety-critical control of sensors and actuators  
**Priority:** Determinism, reliability, offline operation, low resource usage

### Recommended Stack

| Concern | Choice |
|---|---|
| Language | Rust |
| Async Runtime | Tokio |
| Messaging | MQTT (Mosquitto broker; `rumqttc` client) |
| Hardware Abstraction | Traits + simulated backend (HAL) |
| API | REST via `axum` (config + status + control) |
| Frontend | None — headless; UI is the Phase 2 frontend |
| Deployment Target | Local (Docker) |

> **Crate selections.** The broker is fixed by
> [RFC-001](../../decisions/request-for-comments.md#rfc-001-mqtt-broker-selection); the Rust
> client (`rumqttc`) and web framework (`axum`) crates are selected at the Cargo bootstrap. Both
> are Tokio-native and recorded here rather than in a separate RFC. Full host-tooling list is in
> [`required-dependencies.md`](./required-dependencies.md#phase-1--greenhouse-climate-controller).

### Why This Stack

- **Rust + Tokio** — deterministic async, memory safety, real-time performance
- **HAL layer** — simulates sensors (temp, humidity, CO₂, soil moisture) and actuators (fan, heater, vents, misters, irrigation, grow lights); swap in real hardware later
- **MQTT** — lightweight, reliable IoT messaging with QoS + retained messages
- **REST** — the controller's only inbound write path (config + setpoints + manual override); telemetry goes out over MQTT
- **Headless** — no local dashboard; the Phase 2 React frontend is the system's only UI (monitors 1+ controllers). In standalone Phase 1 the controller is inspected via MQTT tooling + REST
- **Zero cloud dependency** — controller keeps running regardless of network

> **Layer archetype:** Embedded systems + real-time control

---

## Phase 2 — Local PaaS Platform (Docker-Only)

**Goal:** Full SaaS-like platform for dashboards, analytics, and device management — running entirely on localhost  
**Priority:** Local completeness, realistic PaaS architecture patterns, zero cloud dependency

> **Delivered in two slices.** **2a** (the MVP that makes the frontend usable against a controller):
> Go API, TimescaleDB, Mosquitto, nginx, React — the telemetry pipeline plus an ad-hoc setpoint-edit
> relay, unauthenticated on the local network. **2b** adds **Keycloak** (auth) and
> **Prometheus/Grafana** (observability) alongside crop profiles, resolution, and reconciliation. The
> stack table below is the full Phase 2 set; the Compose service split (2a vs 2b) is in
> [08-spec-platform-operations.md](./platform/08-spec-platform-operations.md#2-deployment).

### Recommended Stack

| Concern | Choice |
|---|---|
| Language | Go |
| Web Framework | Echo |
| API Style | REST + WebSockets |
| Database | TimescaleDB (PostgreSQL extension) |
| Frontend | React |
| Frontend Testing | Playwright (E2E + live-update) + Lighthouse CI (perf/a11y) |
| Auth | Keycloak (OIDC) |
| Reverse Proxy | nginx |
| Orchestration | Docker Compose |
| MQTT Broker | Mosquitto |

### Why This Stack

- **Go + Echo** — simple, fast, reliable API service
- **TimescaleDB** — adopted from day one as the correct time-series database for greenhouse sensor data; because it is a PostgreSQL *extension* (not a separate database), the same store also holds the **greenhouse registry and crop profiles** (per-greenhouse metadata + per-crop/stage climate targets) in ordinary relational tables alongside the time-series telemetry. See [RFC-002](../../decisions/request-for-comments.md#rfc-002-phase-2-persistence-layer)
- **React** — modern SPA dashboard served by the nginx entry point
- **Playwright + Lighthouse CI** — Playwright drives the real SPA for E2E flows and live-update (WebSocket) latency assertions; Lighthouse CI gates initial-load performance and accessibility against the production build. Together they cover both halves of `P2-USE-1` ([Non-Functional Requirements](../artifacts/non-functional-requirements.md))
- **Keycloak** — self-hosted OIDC identity provider; runs locally as a container (no cloud dependency) and owns login, the user store, and roles so the API never handles credentials
- **nginx** — single entry point: serves the SPA and reverse-proxies `/api` and `/auth`; chosen over Traefik because the service map is static and config-driven (see [RFC-003](../../decisions/request-for-comments.md#rfc-003-phase-2-platform-ingress))
- **Docker Compose** — single-command local orchestration; no cloud account needed

> **Layer archetype:** PaaS platform + microservice architecture (local)

### Docker Compose Services

| Service | Implementation |
|---|---|
| `api` | Go + Echo |
| `db` | TimescaleDB (PostgreSQL + extension) |
| `mqtt` | Mosquitto |
| `auth` | Keycloak |
| `proxy` | nginx (single entry point; also serves the SPA) |
| `frontend` | Built React app served by the `proxy` nginx |

**Connections:**
- **Phase 1 controller** → local MQTT broker
- **API** → local PostgreSQL
- **Frontend** → API over HTTP/WebSockets

---

## Phase 3 — LLM Climate Optimizer (Python-Only)

**Goal:** AI-driven planning, simulation-validated optimization, human-in-the-loop control  
**Priority:** Flexibility, experimentation, simulation, LLM integration

### Recommended Stack

| Concern | Choice |
|---|---|
| Language | Python |
| Framework | FastAPI |
| LLM Integration | LangChain (`langchain-anthropic`, `langchain-openai`, `langchain-community`) — `ChatAnthropic`/`ChatOpenAI` primary, `ChatOllama` fallback via `.with_fallbacks()`; see [RFC-004](../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface) |
| Simulation Engine | NumPy + SciPy |
| Digital Twin | Custom greenhouse physics model |
| Data Access | TimescaleDB (Phase 2 store) via SQLAlchemy |
| Safety Layer | Constraint engine in Python |
| Actuator Delivery | Phase 2 REST API |
| Deployment | Docker Compose (local) |

### Why This Stack

- **Python** — best language for LLMs, simulation, and optimization
- **FastAPI** — clean service interface for the optimizer
- **Hosted LLM primary** — frontier models produce more reliably constraint-valid multi-variable plans; Docker Desktop containers have outbound internet access by default, so no special networking is needed
- **LangChain** — provides `Runnable` chain composition, `ChatPromptTemplate`, `.with_structured_output(ActuatorPlan)`, and `.with_fallbacks()` routing; replaces bespoke prompt construction, output parsing, and fallback logic
- **Ollama fallback** — preserves planning continuity when the hosted backend is temporarily unreachable; wired via LangChain's `.with_fallbacks()`, transparent to the planning loop
- **Backend-agnostic invocation strategy** — fixed token budget, hourly summaries, adaptive horizon, state-change gate, and fixed cadence applied before any backend call; strategy is identical for both backends
- **NumPy/SciPy** — simulation of heat, humidity, and CO₂ dynamics
- **Constraint engine** — validates LLM-generated actuator plans before execution
- **TimescaleDB** — historical data from Phase 2 feeds the optimizer
- **Flexible by design** — this layer evolves as LLM capabilities do

> **Layer archetype:** AI systems + digital twin + agentic planning
