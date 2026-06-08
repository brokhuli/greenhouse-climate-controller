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
| Local Database | SQLite (optional persistence) |
| Messaging | MQTT (Mosquitto) |
| Hardware Abstraction | Traits + simulated backend (HAL) |
| API | REST (config + status) |
| Streaming | WebSockets (logs + real-time events) |
| Frontend | SvelteKit (local dashboard) |
| Deployment Target | Local (Docker) |

### Why This Stack

- **Rust + Tokio** — deterministic async, memory safety, real-time performance
- **HAL layer** — simulates sensors (temp, humidity, CO₂, soil moisture) and actuators (fan, heater, vents, misters, irrigation, grow lights); swap in real hardware later
- **SQLite** — offline resilience, no external dependencies
- **MQTT** — lightweight, reliable IoT messaging with QoS + retained messages
- **WebSockets** — real-time log and telemetry streaming to the UI
- **Zero cloud dependency** — controller keeps running regardless of network

> **Layer archetype:** Embedded systems + real-time control

---

## Phase 2 — Local PaaS Platform (Docker-Only)

**Goal:** Full SaaS-like platform for dashboards, analytics, and device management — running entirely on localhost  
**Priority:** Local completeness, realistic PaaS architecture patterns, zero cloud dependency

### Recommended Stack

| Concern | Choice |
|---|---|
| Language | Go |
| Web Framework | Echo |
| API Style | REST + WebSockets |
| Database | TimescaleDB (PostgreSQL extension) |
| Frontend | React |
| Auth | Keycloak (OIDC) |
| Reverse Proxy | nginx |
| Orchestration | Docker Compose |
| MQTT Broker | Mosquitto |

### Why This Stack

- **Go + Echo** — simple, fast, reliable API service
- **TimescaleDB** — adopted from day one as the correct time-series database for greenhouse sensor data; because it is a PostgreSQL *extension* (not a separate database), the same store also holds the **greenhouse registry and crop profiles** (per-greenhouse metadata + per-crop/stage climate targets) in ordinary relational tables alongside the time-series telemetry. See [RFC-002](../../decisions/request-for-comments.md#rfc-002-phase-2-persistence-layer)
- **React** — modern SPA dashboard served by the nginx entry point
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

## Phase 3 — Local LLM Climate Optimizer (Python-Only)

**Goal:** AI-driven planning, simulation-validated optimization, human-in-the-loop control — running locally  
**Priority:** Flexibility, experimentation, simulation, local LLM integration

### Recommended Stack

| Concern | Choice |
|---|---|
| Language | Python |
| Framework | FastAPI |
| LLM Integration | Local LLM (Ollama) or API call (OpenAI / Anthropic) |
| Simulation Engine | NumPy + SciPy |
| Digital Twin | Custom greenhouse physics model |
| Data Access | TimescaleDB (Phase 2 store) via SQLAlchemy |
| Safety Layer | Constraint engine in Python |
| Actuator Delivery | MQTT or Phase 2 REST API |
| Deployment | Docker Compose (local) |

### Why This Stack

- **Python** — best language for LLMs, simulation, and optimization
- **FastAPI** — clean service interface for the optimizer
- **Local LLM (Ollama)** — keeps everything offline; swap for an API-based LLM for higher capability
- **NumPy/SciPy** — simulation of heat, humidity, and CO₂ dynamics
- **Constraint engine** — validates AI-generated actuator plans before execution
- **TimescaleDB** — historical data from Phase 2 feeds the optimizer
- **Flexible by design** — this layer evolves as LLM capabilities do

> **Layer archetype:** AI systems + digital twin + agentic planning (local)
