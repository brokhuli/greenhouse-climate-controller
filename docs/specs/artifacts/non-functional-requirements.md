# Non-Functional Requirements

## NFR Priority by Phase

Rated **Critical / High / Medium / Low / N/A** based on what each phase is and what would go wrong
if the NFR were ignored.

### Phase 1 — Rust controller, real-time control loop, simulated HAL

| NFR                 | Importance | Why                                                                                        |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| **Reliability**     | Critical   | Fault tolerance *is* the feature — sensor fusion, fault detection, fail-safe responses     |
| **Resilience**      | Critical   | Graceful degradation when probes fail IS the designed behavior                             |
| **Performance**     | Critical   | Tick rate and safety latency are load-bearing decisions; jitter means missed interlocks    |
| **Testability**     | Critical   | Safety logic cannot be shipped untested; HAL exists specifically to enable this            |
| **Observability**   | High       | MQTT telemetry is the only window into a headless process                                  |
| **Modifiability**   | High       | Explicit seams for Phases 2–4 (HAL trait, actuator-as-set-of-effects)                      |
| **Maintainability** | High       | Sets patterns inherited by later phases                                                    |
| **Availability**    | High       | Models a real production system — an unresponsive controller means an unmanaged greenhouse |
| Portability         | Medium     | Windows binary → Docker container for Phase 2; HAL trait handles the rest                  |
| Scalability         | N/A        | Single controller by design                                                                |
| Usability           | N/A        | Headless                                                                                   |
| Security            | N/A        | Local dev machine, no auth planned                                                         |

### Phase 2 — Platform, fleet management, dashboard, TimescaleDB

| NFR                 | Importance | Why                                                                                             |
| ------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| **Scalability**     | Critical   | Core design question: N controllers publishing concurrently                                     |
| **Observability**   | Critical   | The dashboard *is* the product — making internal state visible to operators                     |
| **Performance**     | High       | Ingestion throughput, WebSocket fan-out lag, DB write rate under load                           |
| **Usability**       | High       | First user-facing surface in the system                                                         |
| **Availability**    | High       | Operators need the platform running; controllers are independent but blind without it           |
| **Maintainability** | High       | Platform is the integration point for Phase 3                                                   |
| Reliability         | Medium     | Platform failure is an operational inconvenience, not a safety event (controllers keep running) |
| Resilience          | Medium     | Missed telemetry during downtime is a data gap, not a control failure                           |
| Testability         | Medium     | Integration-heavy; harder to test but important                                                 |
| Modifiability       | Medium     | Must accept Phase 3 optimizer as a new caller without rework                                    |
| Security            | Low        | Local Docker network, no external exposure planned                                              |
| Portability         | Low        | Docker handles this                                                                             |

### Phase 3 — Python optimizer, LLM-assisted planning, digital twin simulation

| NFR               | Importance | Why                                                                                                     |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| **Performance**   | Critical   | Optimizer must solve within the planning horizon it targets; a slow solve is useless                    |
| **Testability**   | Critical   | LLM proposals must be validated against crop-safe constraints; this is the entire correctness guarantee |
| **Reliability**   | High       | Fallback when optimizer fails must be clean (hold last setpoints, don't crash controller)               |
| **Resilience**    | High       | Graceful degradation = Phase 2 static baseline continues unchanged if optimizer is down                 |
| **Modifiability** | High       | Phase 4 extends the optimizer with weather feeds and combustion-aware planning                          |
| **Observability** | High       | LLM proposals must be inspectable — operators need to see why the optimizer chose a plan                |
| Maintainability   | Medium     | Python service with LLM integration — likely to change most between phases                              |
| Scalability       | Low        | N independent per-greenhouse planners; each is stateless relative to the others                         |
| Security          | Low        | LLM API key handling is the one concern                                                                 |
| Usability         | Low        | Likely no direct UI                                                                                     |
| Availability      | Low        | Optimizer being down is tolerable; Phase 2 baseline continues                                           |
| Portability       | Low        | Python + Docker                                                                                         |

### Phase 4 — Combustion heater, weather-reactive control, actuator coordination

| NFR               | Importance | Why                                                                                               |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| **Modifiability** | Critical   | The HAL seam must hold — new actuator as a new backend, not a HAL rewrite                         |
| **Testability**   | Critical   | Combustion heater couples three variables; actuator-selection logic is the new complexity surface |
| **Reliability**   | High       | Combustion heater faults are more dangerous than electric heater faults                           |
| **Resilience**    | High       | Fall back to electric heater if combustion fails                                                  |
| Performance       | Medium     | Weather-reactive planning adds an external I/O dependency (forecast API latency)                  |
| Security          | Medium     | First real external network call (weather API); first external credential                         |

---

## Specific Requirements by Phase

Concrete, committed targets for every applicable (non-N/A) NFR category. Each requirement has a stable
ID (`P{phase}-{CATEGORY}-{n}`) so it can be cited from tests, ADRs, and commit messages. Numbers are
grounded in the design specs where those fix a value; otherwise they are committed engineering
defaults appropriate to a local, simulated, single-machine system. These are firm targets, not
aspirations — a change validates against them.

### Phase 1 — Rust controller, real-time control loop, simulated HAL

HAL time constants ([HAL §2](../design/controller/03-spec-controller-hal-simulation.md#2-coupled-first-order-lag)): temperature τ = 120 s, humidity τ = 60 s, CO₂ τ = 30 s.

**Performance**

- **P1-PERF-1** — The control loop runs on a fixed **1 Hz tick (1000 ms)**. *(Committed default;
  comfortably faster than the smallest τ of 30 s.)*
- **P1-PERF-2** — Tick jitter stays **≤ 50 ms** (5% of the tick period). *(Committed default.)*
- **P1-PERF-3** — Full-pipeline compute per tick (fusion → actuators) stays **≤ 100 ms** on one core.
  *(Committed default.)*
- **P1-PERF-4** — Resident memory **≤ 50 MB** and steady-state CPU **≤ 5%** of one core. *(Committed
  default; consistent with running 20–50 controllers concurrently on one dev machine;
  [architecture §9](../design/controller/02-spec-controller-architecture.md#9-availability-restart--resource-footprint).)*

> **Time-scale note (simulation-only).** P1-PERF-1 / P1-PERF-2 describe the **1× (real-time)
> baseline**. On the simulated HAL a per-controller
> [`time_scale`](../design/controller/03-spec-controller-hal-simulation.md#time-scale-speed-without-breaking-determinism)
> knob scales only the wall-clock tick *cadence* (`sleep = 1000 / time_scale` ms), so off 1× the
> effective period and the absolute jitter move with it — the fixed-1 Hz / ≤50 ms targets are stated
> at 1×, and the knob is bounded to the simulated backend. It does **not** relax the per-tick compute
> budget **P1-PERF-3** (which is what caps the maximum usable speed), and it does **not** affect
> **P1-TEST-2**: `Δt` and the seeded draw order are unchanged, so replay stays tick-indexed and
> bit-identical at any speed. See [HAL §7](../design/controller/03-spec-controller-hal-simulation.md#time-scale-speed-without-breaking-determinism)
> and [controller constraints §1](../design/controller/10-spec-controller-constraints.md#1-determinism--real-time).

**Reliability**

- **P1-REL-1** — A safety interlock condition is acted on **within one tick (≤ 1 s)** of detection.
  *(Hard requirement; [safety §2](../design/controller/06-spec-controller-safety-and-constraints.md#2-safety-interlocks) — interlocks are always active with unconditional priority. The
  re-arm hysteresis added in safety §2 governs **clearing only**; assertion latency is
  unchanged.)*
- **P1-REL-2** — Temperature tolerates **one faulty probe with no degradation** via 3-probe TMR median
  voting. *([sensing §2](../design/controller/04-spec-controller-sensing.md#2-redundant-temperature-fusion-tmr).)*
- **P1-REL-3** — Stuck and out-of-range sensor faults are detected within a **configurable window
  (default 5 ticks)**. *([sensing §4](../design/controller/04-spec-controller-sensing.md#4-fault-detection-non-temperature-sensors).)*
- **P1-REL-4** — Actuator **stuck** (observed state diverges from commanded) and **no-response** (a
  commanded change produces no movement in the variable it drives) faults are detected within a
  **configurable window (default 5 ticks)**, and the affected actuator/zone is failed safe.
  *([safety §5](../design/controller/06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring) — the actuator analogue of P1-REL-3.)*

**Resilience**

- **P1-RESIL-1** — On loss of a temperature probe, control continues on the remaining two (degraded);
  on total disagreement, the controller holds a safe state — **zero unhandled-fault crashes**.
  *([sensing §2](../design/controller/04-spec-controller-sensing.md#2-redundant-temperature-fusion-tmr), [safety §2](../design/controller/06-spec-controller-safety-and-constraints.md#2-safety-interlocks).)*
- **P1-RESIL-2** — A manual override **auto-expires after a configurable timeout** so a forgotten
  override cannot strand the greenhouse. *([architecture §6](../design/controller/02-spec-controller-architecture.md#6-manual-override).)*
- **P1-RESIL-3** — Telemetry publishing **never blocks the control tick**: it runs on a decoupled
  task, so a slow or **disconnected MQTT broker cannot stall control**. On reconnect, publishing
  resumes and the retained `gh/{id}/state` snapshot re-primes subscribers; telemetry lost while
  disconnected is a **recoverable data gap, not a control failure**.
  *([interfaces §7](../design/controller/08-spec-controller-interfaces.md#7-mqtt-connection-resilience).)*

**Testability**

- **P1-TEST-1** — **≥ 90% line coverage** on the control-loop and safety-interlock modules. *(Committed
  default; CLAUDE.md "avoid untested logic".)*
- **P1-TEST-2** — The HAL simulation is **deterministic under a fixed seed** for reproducible tests.
  *([HAL §7](../design/controller/03-spec-controller-hal-simulation.md#7-determinism--seeding).)*

**Observability**

- **P1-OBS-1** — Telemetry (readings, actuator states, system state) is published **every tick at
  1 Hz**; fault events are published **within one tick** of detection. *([interfaces §2](../design/controller/08-spec-controller-interfaces.md#2-mqtt--telemetry-out).)* *(One publish per tick; under the simulation `time_scale` knob the wall-clock rate is `time_scale × 1 Hz`, but it stays exactly one frame per tick.)*
- **P1-OBS-2** — The REST `/health` endpoint reflects **every active fault and alarm**. *([sensing §6](../design/controller/04-spec-controller-sensing.md#6-fault-surfacing), [interfaces §5](../design/controller/08-spec-controller-interfaces.md#5-published-shapes--health).)*

**Modifiability**

- **P1-MOD-1** — A new actuator (e.g. the Phase 4 combustion heater) is added as a **new HAL backend
  implementing the same trait, with zero changes to the control loops**. *([HAL §4](../design/controller/03-spec-controller-hal-simulation.md#4-the-actuator-effect-set-invariant)
  interface constraint; RFC-006.)*

**Maintainability**

- **P1-MAINT-1** — Each pipeline stage (fusion, setpoint resolution, control loops, interlocks,
  constraints) is a **separately testable module behind an explicit interface**.
  *([architecture §5](../design/controller/02-spec-controller-architecture.md#5-module-composition-rules);
  CLAUDE.md architecture.)*

**Availability**

- **P1-AVAIL-1** — **≥ 99.9% availability** over a continuous run; restart to first control tick is
  **< 5 s**. *(Committed default; the controller models a real production system;
  [architecture §9](../design/controller/02-spec-controller-architecture.md#9-availability-restart--resource-footprint).
  Precondition: an external supervisor — Docker `restart:` in managed mode, a Windows
  service wrapper in standalone — since the controller does not self-supervise.)*

**Portability**

- **P1-PORT-1** — The **same binary runs native on Windows and as a Docker container** with no code
  change (configuration via TOML). *([architecture §8](../design/controller/02-spec-controller-architecture.md#8-deployment).)*

### Phase 2 — Platform, fleet management, dashboard, TimescaleDB

**Scalability**

- **P2-SCAL-1** — Establish baseline behavior at **5, 20, and 50 concurrent controllers** and confirm
  **≥ 50 controllers** on one dev machine as the supported target. *(See Performance Testing below.)*

**Performance**

- **P2-PERF-1** — Telemetry ingestion sustains the full MQTT topic fan-out for **50 controllers at
  the 1× baseline (1 Hz)** with **no backlog growth**. For the baseline two-zone simulated greenhouse
  this is **≥ 750 MQTT messages/s** (50 controllers × roughly 15 per-tick readings/state frames); if
  the configured zone count changes, the target scales with the actual contract-defined topic fan-out.
  The simulation `time_scale` knob can deliberately push the platform above or below that baseline:
  below 1× the expected arrival cadence slows with the controller, while above 1× the stream may reach
  `time_scale × 1 Hz` per controller and is treated as a diagnostic/load-test mode. Fast-forward must
  remain bounded by the platform's backpressure and shedding rules; "no backlog growth at 50
  controllers" is guaranteed at 1× unless a test explicitly declares a higher-speed load target.
  *(Derived from P1-OBS-1 × P2-SCAL-1 and the MQTT topic map.)*
- **P2-PERF-2** — WebSocket fan-out lag (ingest → dashboard) is **< 1 s** at 50 controllers.
  *(Committed default.)*
- **P2-PERF-3** — REST API **p95 latency < 200 ms** under concurrent operator + dashboard load.
  *(Committed default.)*
- **P2-PERF-4** — TimescaleDB sustains the full telemetry insert rate at **< 1 s write latency**.
  *(Committed default.)*

**Observability**

- **P2-OBS-1** — The Go API exposes `/metrics`; Prometheus scrapes on a **15 s interval**; Grafana
  dashboards cover ingestion rate, API latency/errors, reconciliation actions, and per-controller
  connectivity. *([operations §1](../design/platform/08-spec-platform-operations.md#1-observability); 2b.)*
- **P2-OBS-2** — Every setpoint write emits a **structured (`slog`) audit log entry with provenance**.
  *([operations §1](../design/platform/08-spec-platform-operations.md#1-observability), [crop profiles §5](../design/platform/05-spec-platform-crop-profiles.md#5-fleet-management--operator-control).)*

**Usability**

- **P2-USE-1** — Dashboard **initial load < 2 s**; live charts render new samples at the source
  cadence, with a **≥ 1 Hz** live-update target at the 1× baseline and any faster simulation. Under a
  slowed simulated controller (`time_scale < 1`), fewer samples are produced by design, so the chart
  advances at that slower source cadence without being considered stale. *(Committed default;
  initial-load half validated by Lighthouse CI against the production build, live-update half by
  Playwright — see P2-TEST-2.)*

**Availability**

- **P2-AVAIL-1** — Platform **≥ 99.5% availability**; a platform restart **never interrupts controller
  control loops** (controllers are independent failure domains). *([overview §1](../design/platform/01-spec-platform-overview.md#1-what-the-platform-is).)*

**Reliability**

- **P2-REL-1** — Setpoint reconciliation **re-asserts intended state on controller reconnect within
  one reconciliation cycle**. *([crop profiles §3](../design/platform/05-spec-platform-crop-profiles.md#3-reconciliation--the-platform-is-the-source-of-truth); 2b.)*

**Resilience**

- **P2-RESIL-1** — Telemetry lost during platform downtime is a **recoverable data gap, not a control
  failure**; ingestion resumes automatically on restart. *([overview §1](../design/platform/01-spec-platform-overview.md#1-what-the-platform-is), [ingestion §1](../design/platform/04-spec-platform-ingestion.md#1-subscribe-and-store).)*

**Testability**

- **P2-TEST-1** — An integration test covers the **full up/down path** (MQTT ingest → store; profile
  resolve → controller REST). *([architecture §3](../design/platform/02-spec-platform-architecture.md#3-three-data-flows).)*
- **P2-TEST-2** — The React dashboard is validated with **Playwright** (E2E flows + live-update latency
  over the WebSocket stream — the 1× / source-cadence half of P2-USE-1, including a slowed-simulation
  case that must not be marked stale solely because samples arrive below 1 Hz) and **Lighthouse CI**
  (initial-load performance + accessibility), both run against the **production build**, not the dev
  server.
  *(Committed default.)*

**Modifiability**

- **P2-MOD-1** — The Phase 3 optimizer integrates via the **existing `POST /setpoints` path with zero
  breaking interface changes**. *([crop profiles §4](../design/platform/05-spec-platform-crop-profiles.md#4-boundary-with-phase-3--single-setpoint-authority), [interfaces §3](../design/platform/09-spec-platform-interfaces.md#3-api-surface-inventory); RFC-005.)*

**Security**

- **P2-SEC-1** — 2b: **Keycloak OIDC with viewer/operator roles**; every **human** write path requires
  the operator role. The one **service** write path (`POST /setpoints`) requires the narrow
  `setpoints:write` role under `SERVICE_AUTH_MODE=oidc` — [RFC-011](../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009).
  *([security §3](../design/platform/07-spec-platform-security.md#3-roles-and-role-mapping), [§4](../design/platform/07-spec-platform-security.md#4-capability-matrix), [§5](../design/platform/07-spec-platform-security.md#5-the-2a-unauthenticated-stance--and-the-deferred-service-auth-mode); 2b.)*

**Portability**

- **P2-PORT-1** — The whole stack stands up with **one `docker compose up`**, no cloud account.
  *([operations §2](../design/platform/08-spec-platform-operations.md#2-deployment).)*

### Phase 3 — Python optimizer, LLM-assisted planning, digital twin simulation

**Performance**

- **P3-PERF-1** — Each planning cycle completes **within its 30-min cadence** (default
  `cycle_interval_minutes = 30`). *(Spec §4.)*
- **P3-PERF-2** — A single LLM plan call returns in **< 60 s**; on timeout the current plan is extended
  rather than blocking. *(Committed default; spec §4 state-change gate.)*
- **P3-PERF-3** — `PlanContext` serializes to a **fixed 4 000-token budget**; exceeding it raises an
  explicit error (no silent truncation). *(Spec §4.)*

**Testability**

- **P3-TEST-1** — **100% of LLM-proposed plans pass through the deterministic constraint engine before
  apply**; the engine's bound checks have **≥ 90% coverage**. *(Spec §5.)*

**Reliability**

- **P3-REL-1** — On optimizer failure the controller holds its last accepted setpoints — **zero
  controller crashes caused by the optimizer**. *(Spec §5, §6.)*

**Resilience**

- **P3-RESIL-1** — With the optimizer down, the **Phase 2 static crop-profile baseline continues
  unchanged**. *(Spec §6.)*

**Modifiability**

- **P3-MOD-1** — The invocation strategy is **backend-agnostic** (hosted or local LLM) with no change
  to the plan path. *(Spec §4.)*

**Observability**

- **P3-OBS-1** — Every applied or escalated plan is **traceable by `optimizer_run_id`**; escalations
  surface the proposed plan and the reason it was held. *(Spec §6.)*

**Maintainability**

- **P3-MAINT-1** — Context preparation, constraint engine, and applier are **separable modules**; the
  LLM backend is swappable without touching them. *(Spec §4, §5.)*

**Scalability**

- **P3-SCAL-1** — The optimizer plans **one greenhouse at a time** — N independent planners, no shared
  state. *(Spec §1.)*

**Security**

- **P3-SEC-1** — The LLM API key is supplied **via environment/secret and never logged**. *(Committed
  default.)*

**Usability**

- **P3-USE-1** — Escalated plans are **surfaced for operator review** with plan + reason, not silently
  dropped. *(Spec §6.)*

**Availability**

- **P3-AVAIL-1** — Optimizer downtime is tolerable: control and the Phase 2 baseline are unaffected
  (see P3-RESIL-1). *(Spec §6.)*

**Portability**

- **P3-PORT-1** — Runs as a **Python service under Docker Compose**, no cloud account. *(Spec §1.)*

### Phase 4 — Combustion heater, weather-reactive control, actuator coordination

**Modifiability**

- **P4-MOD-1** — The combustion heater is added as a **new HAL backend with zero HAL rewrite**;
  actuator-selection coordination is layered above the existing PIDs. *(Spec §1; RFC-006.)*

**Testability**

- **P4-TEST-1** — Actuator-selection coordination (electric vs burner, injector vs burner) has
  **dedicated tests for the coupled temperature + CO₂ + humidity case**. *(Spec §1.)*

**Reliability / Resilience**

- **P4-REL-1** — On a combustion fault the controller **falls back to the electric heater within one
  tick**. *(Committed default; spec §3.)*

**Performance**

- **P4-PERF-1** — A weather forecast fetch completes in **< 5 s** and is cached; a fetch failure falls
  back to the last-known forecast and **never blocks the control tick**. *(Committed default; spec §1.)*

**Observability**

- **P4-OBS-1** — Device-selection decisions (which heat/CO₂ source ran and why) are **published in
  telemetry** for after-the-fact analysis. *(Committed default; spec §1.)*

**Security**

- **P4-SEC-1** — The weather API credential is supplied **via environment/secret and never logged**
  (the system's first external network egress). *(Committed default.)*

---

## Performance Testing

The primary performance concern is **platform scalability with controller count** — how the Phase 2
platform behaves as N Phase 1 controllers publish telemetry, receive setpoint updates, and appear in
the fleet view simultaneously.

### Test method

Controllers run as Docker containers on the local development machine (see
[platform deployment](../design/platform/08-spec-platform-operations.md#2-deployment)). A generation script produces a
`docker-compose.override.yml` with N named controller services; `docker compose up -d` brings the
full stack up. To vary N, regenerate and redeploy.

Because the controller HAL is pure simulation, each controller is a lightweight process — running
20–50 controllers concurrently on a developer machine is the expected practical range. These tests
confirm the committed **≥ 50-controller** target (`P2-SCAL-1`) and characterize headroom above it.

### What to observe

| Signal                   | Why it matters                                                         |
| ------------------------ | ---------------------------------------------------------------------- |
| Telemetry ingestion rate | MQTT → DB write throughput under N concurrent publishers               |
| Reconciliation latency   | Time from a profile/setpoint change to the controller acknowledging it |
| WebSocket fan-out lag    | Delay from ingestion to the dashboard receiving a live update          |
| DB write throughput      | TimescaleDB insert rate under sustained telemetry load                 |
| API response times       | REST endpoint latency under concurrent operator and dashboard load     |

### Goals

These tests **validate the committed Phase 2 targets** (`P2-SCAL-1`, `P2-PERF-1`…`P2-PERF-4`) at
representative controller counts (5, 20, 50) and surface bottlenecks before they reach those limits.
Baselines captured here become the regression reference for the targets above.
