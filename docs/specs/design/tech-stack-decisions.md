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
| Messaging | MQTT (Mosquitto or EMQX) |
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
| Database | Postgres or TimescaleDB |
| Frontend | React |
| Auth | Keycloak (OIDC) or simple JWT in Go |
| Reverse Proxy | Traefik or nginx |
| Orchestration | Docker Compose |
| MQTT Broker | EMQX or Mosquitto |

### Why This Stack

- **Go + Echo** — simple, fast, reliable API service
- **TimescaleDB** — correct time-series database for greenhouse sensor data; Postgres is fine for early phases. The same relational store also holds the **greenhouse registry and crop profiles** (per-greenhouse metadata + per-crop/stage climate targets) alongside the time-series data
- **React** — modern SPA dashboard served via nginx or the API
- **Keycloak** — realistic local OIDC identity provider; swap for simple JWT to start
- **Traefik/nginx** — reverse proxy routing between containers
- **Docker Compose** — single-command local orchestration; no cloud account needed

> **Layer archetype:** PaaS platform + microservice architecture (local)

### Docker Compose Services

| Service | Implementation |
|---|---|
| `api` | Go + Echo |
| `db` | PostgreSQL (optionally TimescaleDB) |
| `mqtt` | EMQX or Mosquitto |
| `auth` | Keycloak, or simple JWT in Go |
| `proxy` | Traefik or nginx (optional) |
| `frontend` | Built React app served by nginx or the API |

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
| Data Access | Postgres/TimescaleDB via SQLAlchemy |
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
