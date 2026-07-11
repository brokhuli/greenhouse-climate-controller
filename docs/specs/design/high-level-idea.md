Below is the **fully expanded, portfolio‑ready summary** of your entire system — with **what it is**, **what each phase does**, **detailed internals (HAL, simulated sensors, etc.)**, **simple diagrams**, **tech stacks**, and **skills you gain in each phase**.

This is the most complete and accurate description of your architecture so far.

---

# **🌱 SYSTEM SUMMARY — “Local Greenhouse Intelligence Platform”**

Your system is a **three‑phase, fully local, containerized greenhouse automation and intelligence platform**.  
It simulates:

- a **real greenhouse controller** (Phase 1)
- a **local cloud‑like PaaS** for dashboards, analytics, and device management (Phase 2)
- an **AI‑driven climate optimizer** that generates actuator plans (Phase 3)

Everything runs **locally**, using **Docker**, **MQTT**, **REST**, **WebSockets**, and **local databases**.  
It mirrors real IoT + SaaS architecture patterns without requiring any cloud services.

> **Beyond the core product:** a **Phase 4** stretch goal — taken on only *after* the three‑phase
> product is finished — extends the optimizer with a **combustion heater** (coupled multi‑variable
> actuation) and **real weather** (forecast‑driven, weather‑reactive predictive control). It is
> described after Phase 3 below.

---

# **PHASE 1 — Greenhouse Climate Controller (Local‑Only)**

**Purpose:** Deterministic real‑time control loop with simulated sensors and actuators.

---

## **What Phase 1 Does**

> This is the high‑level summary. The physical system (sensors, actuators, coupling) is detailed in
> [`physical-system-single.md`](./physical-system-single.md); the controller architecture, control loops,
> configuration, and fault handling are in
> [`01-spec-controller-overview.md`](./controller/01-spec-controller-overview.md).

- Runs a **Rust controller** with a real embedded‑style architecture
- Implements a **HAL (Hardware Abstraction Layer)**
  - Simulated sensors: temperature (×3 redundant), humidity, CO₂, soil moisture (per zone), PAR (light)
  - Simulated actuators: heater, fans, roof vents, misters, CO₂ injector, irrigation valves (per zone), grow lights, shade screen
- Fuses the **three redundant temperature probes** by median voting for fault tolerance
- Runs a **temperature PID loop** (heater + fans + vents) and a **humidity hysteresis band** (misters)
- Targets **VPD** (computed from temperature + humidity) as the true climate objective
- Controls **CO₂** with a hard **vent interlock** (no enrichment while vents are open)
- **Schedules irrigation** by time‑of‑day + soil moisture threshold, per zone
- Manages **lighting** via daily light integral (DLI) accumulation — grow lights + shade screen
- Applies a **rule engine** for coupled multi‑condition actuator logic
- Enforces **safety interlocks** (critical‑temp override, CO₂ ceiling, irrigation fault)
- Detects **sensor faults** (stuck sensor, outlier rejection)
- Publishes readings, actuator state, faults, and system state via **MQTT** (QoS + retained); MQTT is telemetry-only — setpoints arrive over the REST config API, not MQTT (the controller is setpoint-only — [RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain))
- Exposes a **REST API** for configuration and control (the sole write path)
- Is **headless** — no local UI; visualization is the Phase 2 frontend's job (Phase 1 is observed in standalone dev via MQTT tooling + REST)

---

## **Phase 1 Diagram (Simple)**

```
+------------------------------+
|   Rust Controller            |
|  (headless — MQTT + REST)    |
|  - Temp Fusion (3x voting)   |
|  - Temp PID / Humidity Band  |
|  - VPD Target                |
|  - CO₂ + Vent Interlock      |
|  - Irrigation Scheduler      |
|  - Lighting / DLI            |
|  - Rule Engine               |
|  - Safety Interlocks         |
|  - Fault Detection           |
|  - HAL Layer                 |
|     - Simulated Sensors      |
|     - Simulated Actuators    |
|  - Config / Control API (REST)|
+---------------+--------------+
                | MQTT
                v
+------------------------------+
|   Local MQTT Broker          |
|   Mosquitto                  |
+------------------------------+
```

---

## **Phase 1 Tech Stack**

- **Rust (Tokio)** — deterministic async controller
- **HAL Layer**
  - Simulated sensors: temperature (×3 redundant), humidity, CO₂, soil moisture (per zone), PAR
  - Simulated actuators: heater, fans, roof vents, misters, CO₂ injector, irrigation valves (per zone), grow lights, shade screen
- **Sensor fusion** — redundant temperature probes fused by median voting (fault tolerance)
- **PID + hysteresis control** — temperature PID, humidity band, VPD target
- **Rule engine** — coupled multi‑condition logic + safety interlocks
- **MQTT (Mosquitto)** — messaging with QoS + retained messages
- **REST API** — config + status + control (the sole write path)

---

## **Skills You Gain in Phase 1**

- **Embedded‑style architecture** (HAL, drivers, control loops)
- **Rust async systems** (Tokio)
- **Hysteresis + threshold control**
- **Sensor fusion** (redundant sensors, median voting, fault tolerance)
- **PID tuning and closed‑loop control**
- **Rule engine design and actuator orchestration**
- **Safety interlock patterns**
- **Sensor fault detection**
- **MQTT pub/sub patterns** with QoS
- **REST API design for devices**
- **Simulated hardware modeling**
- **Local IoT system integration**

## **Pills for Portfolio**

- Rust
- HAL
- PID
- Sensor fusion
- MQTT
- REST

---

## **Phase 1 Complexity: 6 / 10**

A full deterministic control system — multi‑sensor, multi‑actuator, with PID, rule engine, safety interlocks, and fault detection.  
Isolated and local, but non‑trivial engineering throughout.

---

# **PHASE 2 — Local PaaS Platform (Docker‑Only)**

**Purpose:** A multi‑greenhouse management platform running entirely on your laptop — aggregates data from multiple Phase 1 controller instances representing separate greenhouses at a single site.

This is your **local cloud**, built from containers.

> **Ships in two slices.** **2a** is the MVP that makes the frontend usable against a controller —
> the telemetry pipeline (MQTT → API → DB → WebSocket → React) plus a thin setpoint-edit relay,
> unauthenticated on the local network. **2b** adds crop profiles + setpoint resolution,
> reconciliation/drift, Keycloak auth, and Prometheus/Grafana. Since Phase 1 controllers are now
> headless, **this frontend is the system's only UI**, and it monitors **one or more** greenhouses.

---

## **What Phase 2 Does**

- Manages **multiple greenhouse controllers** (Phase 1 instances) representing separate greenhouses at a single site
- Provides a **Go API** for multi-greenhouse data and fleet management
- **Owns crop profiles** — a library of per-crop / per-growth-stage climate targets (temperature, humidity band, VPD, DLI, CO₂); assigns one profile to each greenhouse and **resolves it into that controller's setpoints**, pushed down via the Phase 1 REST config API. This is the layer that turns "this is a lettuce house, fruiting stage" into the numbers the crop-agnostic controller regulates to.
- Stores historical data in **TimescaleDB**
- Hosts a **dashboard frontend**
- Manages users via **Keycloak** (self-hosted OIDC)
- Provides a **reverse proxy** for routing
- Integrates with Phase 1 via MQTT + REST
- Runs entirely in **Docker Compose**
- Exposes **operational metrics** + **structured logs**, with **Prometheus/Grafana** dashboards for platform observability

---

## **Phase 2 Diagram (Simple)**

```
+------------------------------+
|   Frontend (nginx)           |
|   React                      |
+---------------+--------------+
                | HTTP
                v
+-------------------------------+   /metrics    +----------------------+
|   Go API (Echo)               |<--------------|   Prometheus         |
|  - Device mgmt                |    (scrape)   |   + Grafana (dash)    |
|  - Crop profiles → setpoints  |               +----------------------+
|  - Data ingestion             |
|  - Analytics endpoints        |
|  - /metrics + structured logs |
+---------------+---------------+
                | DB / MQTT
                v
+------------------+     +------------------+
| TimescaleDB      |     | MQTT Broker      |
| Time-series data |     | Mosquitto        |
+------------------+     +------------------+
                ^                ^
                |                |
                +-------+--------+
                        |
                Phase 1 Controller (greenhouse A, same site)
                Phase 1 Controller (greenhouse B, same site)
                Phase 1 Controller (greenhouse N, same site)
```

---

## **Phase 2 Tech Stack**

- **Go (Echo)** — API service
- **TimescaleDB** — time‑series storage
- **React** — dashboard
- **Keycloak (OIDC)** — auth
- **nginx** — reverse proxy + SPA server (single entry point)
- **Docker Compose** — orchestration
- **MQTT** — device messaging
- **Prometheus + Grafana** — metrics scraping + dashboards
- **Structured logging (slog)** — operational logs from the Go API

---

## **Skills You Gain in Phase 2**

- **Full PaaS architecture** (API, DB, auth, frontend, proxy)
- **Go backend development**
- **Crop-profile modeling** — mapping crop + growth stage to climate targets and resolving them into per-controller setpoints
- **Time‑series database modeling**
- **Docker Compose orchestration**
- **Local microservice networking**
- **Auth systems (Keycloak / OIDC)**
- **Reverse proxy routing**
- **Frontend–backend integration**
- **MQTT ingestion pipelines**
- **Observability** — instrumenting a service (/metrics), Prometheus scraping, Grafana dashboards, structured logging

---

## **Pills for Portfolio**

- PaaS
- Go
- React
- TimescaleDB
- Docker
- Keycloak (OIDC)
- MQTT
- Prometheus
- Grafana

---

## **Phase 2 Complexity: 6 / 10**

A real PaaS, but local‑only.  
No cloud = simpler networking, identity, secrets, and deployment.

---

# **PHASE 3 — Local LLM Climate Optimizer (Python‑Only)**

**Purpose:** AI‑driven planning, simulation, and optimization.

---

## **What Phase 3 Does**

- Runs a **Python service** that:
  - pulls historical data from Postgres
  - simulates greenhouse climate dynamics
  - uses an LLM to propose refined setpoints
  - validates plans against constraints
  - submits refined setpoints **through the Phase 2 API** — Phase 2 is the single authority for
    controller setpoints ([RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain))

---

## **Optimizer Functions (Per Greenhouse)**

The optimizer is the *intelligence* layer above each greenhouse's deterministic Phase 1 controller.
It operates on one greenhouse at a time (N independent planning problems, mirroring Phase 1's N
independent control loops); site-wide orchestration across greenhouses is **out of scope**.

- **Predictive / anticipatory control** — simulate the greenhouse forward and pre-position actuators
  for upcoming conditions instead of reacting after the fact (e.g., pre-cool before a solar peak).
  This is anticipation of *deterministic, clock-known* disturbances (the diurnal solar/temperature
  curve, the day/night setpoint schedule) — it needs no weather feed. Reacting to a real, variable
  forecast (a cold front, passing cloud) is **weather-reactive** control and belongs to Phase 4.
- **Setpoint optimization** — *refine* the crop-profile baseline that Phase 2 already resolves into
  each controller's setpoints. The static "this crop, this stage → these VPD / DLI / CO₂ / temperature
  targets" mapping lives in **Phase 2**; Phase 3 adjusts those targets dynamically (anticipatory,
  cost-aware) within crop-safe bounds and pushes the refined values down — optimizing setpoint
  management rather than introducing it.
- **Coupling-aware planning** — choose the optimal *combination* of coupled actuators
  (vent / fan / mister / heater) to hit VPD + DLI + CO₂ goals together, rather than independent
  reactive loops that can fight each other.
- **Per-greenhouse efficiency** — optimize one greenhouse's own consumption against a cost /
  time-of-use signal.

---

## **Phase 3 Diagram (Simple)**

```
+------------------------------+
|   Python Optimizer           |
|  - LLM orchestration         |
|  - Simulation engine         |
|  - Constraints               |
+---------------+--------------+
                | HTTP / DB / MQTT
                v
+------------------------------+
|   Phase 2 API + DB           |
+---------------+--------------+
                | MQTT
                v
+------------------------------+
|   Phase 1 Controller         |
+------------------------------+
```

---

## **Phase 3 Tech Stack**

- **Python** — core logic
- **FastAPI** — service interface
- **NumPy/SciPy** — simulation
- **LangChain** (`langchain-community` Ollama default local backend, `langchain-anthropic`/`langchain-openai` opt-in cloud backends) — planning chain; see [RFC-004](../../decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface)
- **Phase 2 REST API** — refined-setpoint delivery (Phase 2 is the single setpoint authority; see [RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain))
- **Postgres** — historical data

---

## **Skills You Gain in Phase 3**

- **LLM orchestration** (prompting, planning, validation)
- **Simulation modeling** (heat, humidity, CO₂ dynamics)
- **Constraint‑based planning**
- **Python service architecture**
- **Time‑series analysis**
- **Cross‑service integration** (Phase 1 + Phase 2)
- **Actuator plan generation**
- **Safety‑aware AI design**

---

## **Pills for Portfolio**

- LLM-Orchestration
- Python
- FastAPI
- NumPy/SciPy
- LangChain

---

## **Phase 3 Complexity: 7.5 / 10**

Most complex phase due to simulation + AI + planning + constraints.  
Still simpler than cloud‑integrated AI systems.

---

# **PHASE 4 — Coupled Actuation + Weather-Reactive Optimization (Stretch Goal)**

**Purpose:** A stretch goal taken on *after* the three‑phase product is finished. It extends the
Phase 3 optimizer with the two hardest, most realistic capabilities the core product deliberately
deferred: a **combustion heater** (one device that couples temperature + CO₂ + humidity) and **real
weather** (a live + forecast feed enabling weather‑reactive predictive control).

---

## **What Phase 4 Does**

- **Combustion heater — coupled optimization**
  - Introduces a single actuator that raises **temperature, CO₂, and humidity simultaneously** —
    breaking the independent‑loop assumption the Phase 1 controller relies on.
  - Requires **actuator‑selection coordination *above* the individual PID loops**: with two ways to
    add heat (electric heater vs. burner) and two ways to add CO₂ (clean injector vs. burner), the
    system must *choose the device*, not just run independent loops that can fight each other.
  - Enriches the optimizer's **coupling‑aware planning** into a genuine combinatorial
    actuator‑selection problem under joint VPD / DLI / CO₂ constraints.

- **Weather conditions — predictive control**
  - Ingests a **real weather feed**: live outdoor conditions plus a **site‑wide forecast**.
  - Enables **weather‑reactive** predictive control — pre‑positioning actuators for incoming
    conditions (a cold night to hold off, a sunny afternoon's heat to shed, a humid front rolling
    in), *beyond* Phase 3's anticipation of the deterministic diurnal cycle.
  - Extends the Phase 3 digital twin to plan against a **stochastic future** rather than only a
    known daily profile.

---

## **Phase 4 Diagram (Simple)**

```
+------------------------------+      +------------------------------+
|   Weather Feed               |----->|   Python Optimizer (P3+)     |
|  - Live outdoor conditions   |      |  - Weather-reactive MPC      |
|  - Site-wide forecast        |      |  - Combustion-aware planning |
+------------------------------+      |  - Extended digital twin     |
                                      +---------------+--------------+
                                                      | MQTT / API
                                                      v
                              +------------------------------------+
                              |   Phase 1 Controller               |
                              |   + Combustion heater (coupled:    |
                              |     temp ↑ / CO₂ ↑ / humidity ↑)   |
                              |   + Actuator-selection coordination |
                              +------------------------------------+
```

---

## **Phase 4 Tech Stack**

- **Builds on Phase 3** — Python, FastAPI, NumPy/SciPy, LLM, MQTT, Postgres
- **Weather integration** — external weather‑API / forecast feed (live + horizon)
- **Extended digital twin** — heat/mass‑balance simulation with a **combustion model**
  (joint heat + CO₂ + humidity)
- **Actuator‑selection coordination** — planning layer above the Phase 1 PIDs

---

## **Skills You Gain in Phase 4**

- **Multi‑variable actuator coordination** (selecting among coupled devices)
- **Weather / forecast integration** (external feeds, horizons)
- **Weather‑reactive model‑predictive control** (planning against a stochastic future)
- **Richer simulation modeling** (combustion dynamics in the digital twin)

---

## **Phase 4 Complexity: 9 / 10**

The most complex phase: it couples the deferred **multi‑variable actuator** with an **external,
stochastic forecast feed** and weather‑reactive planning. It also raises the *effective* bar on
Phase 1 — introducing the combustion heater lifts the cap that kept Phase 1 at 6/10, since the
controller now needs actuator‑selection coordination above its PIDs.

---

# **FINAL SUMMARY TABLE**

| Phase                        | Purpose                                                                                                                                                                                                                              | Tech Stack                                                                           | Skills Learned                                                                                                  | Complexity   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------ |
| **Phase 1**                  | Headless local controller                                                                                                                                                                                                            | Rust, HAL, MQTT, REST                                                                | Embedded patterns, PID, rule engine, safety interlocks, fault detection, MQTT, REST device APIs                 | **6 / 10**   |
| **Phase 2**                  | Multi-greenhouse management platform (single site); the system's only UI for 1+ greenhouses; owns crop profiles → controller setpoints. Ships as **2a** (monitoring + setpoint-edit MVP) then **2b** (profiles, auth, observability) | Go, TimescaleDB, MQTT, React, nginx, Docker (2a) + Keycloak, Prometheus/Grafana (2b) | PaaS design, DB modeling, crop-profile/setpoint resolution, auth, microservices, reverse proxy, observability   | **6 / 10**   |
| **Phase 3**                  | Local AI climate optimizer                                                                                                                                                                                                           | Python, FastAPI, NumPy/SciPy, LangChain, MQTT, Postgres                              | Simulation, LLM orchestration, constraints, planning                                                            | **7.5 / 10** |
| **Phase 4** *(stretch goal)* | Coupled actuation + weather-reactive optimization                                                                                                                                                                                    | Phase 3 stack + weather-API/forecast feed, combustion-model digital twin             | Multi-variable actuator coordination, weather/forecast integration, weather-reactive MPC, combustion simulation | **9 / 10**   |

---
