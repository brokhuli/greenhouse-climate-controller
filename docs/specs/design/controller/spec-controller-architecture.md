# Controller — Architecture

> **Purpose:** Describe how the controller is structured at the system level — the
> HAL boundary, the **fixed-tick pipeline** and the data that flows between its
> stages, the real-time/scheduling model, the controller's internal state
> topology, module composition rules, **manual override**, the failure/degradation
> modes, and the deployment shapes. Sits one level above the per-stage detail in
> [HAL simulation](./spec-controller-hal-simulation.md),
> [sensing](./spec-controller-sensing.md),
> [control loops](./spec-controller-control-loops.md), and
> [safety & constraints](./spec-controller-safety-and-constraints.md). Read this to
> understand *how the pieces connect*.

> **Scope note.** Per-stage algorithms live in their own specs; this file owns the
> *composition* — order, timing, state ownership, and degradation. Quality targets
> are owned by the [NFR doc](../../artifacts/non-functional-requirements.md) and
> cited by ID.

---

## 1. System boundaries

```
┌──────────────────────────────────────────────────────────────────────┐
│  Controller process (Rust)                                             │
│                                                                        │
│   ┌──────────────────────── fixed-tick pipeline ────────────────────┐ │
│   │  fusion → fault detect → setpoint resolve → control loops →      │ │
│   │  manual override → safety interlocks → actuator constraints       │ │
│   └──────────────────────────────────────────────────────────────────┘│
│        ▲ raw readings                              commanded outputs ▼  │
│   ┌─────────────────────────── HAL (trait) ─────────────────────────┐ │
│   │  simulated sensors + actuators (swappable for real hardware)     │ │
│   └──────────────────────────────────────────────────────────────────┘│
└───────────────┬───────────────────────────────────────┬──────────────┘
        MQTT (telemetry, out)                    REST (config/control, in)
                ▼                                         ▲
          observers / platform                     platform / operator
```

Two boundaries are load-bearing:

1. **The HAL is the only thing the pipeline touches for I/O.** Stages read sensor
   values and write actuator commands through the HAL trait; they hold no knowledge
   of the simulation behind it. Swapping the simulated HAL for a real one touches
   one module ([HAL simulation](./spec-controller-hal-simulation.md), `P1-MOD-1`).
2. **The external surface observes and configures; it never reaches into the
   pipeline mid-tick.** MQTT publishes a consistent post-tick snapshot; REST writes
   land in controller state and take effect on the *next* tick
   ([interfaces](./spec-controller-interfaces.md)). There is no command path over
   MQTT ([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)).

---

## 2. The tick pipeline

The controller is a pipeline that runs to completion on every tick. Each stage
consumes the previous stage's output; nothing runs concurrently within a tick, so
the per-tick result is a pure function of (sensor readings, controller state).

```
HAL (simulated sensors)
      │  raw readings (incl. 3 temperature probes)
      ▼
① Sensor Fusion + Fault Detection     → trusted state + fault flags   (sensing)
      │  trusted readings
      ▼
② Setpoint Resolution                 → active setpoints this tick     (control-loops, config)
      │
      ▼
③ Control Loops (fast + medium)       → desired actuator outputs       (control-loops)
      │  desired outputs
      ▼
④ Manual Override                     → forced values replace desired  (§6)
      │
      ▼
⑤ Safety Interlocks                   → unconditional overrides         (safety)
      │
      ▼
⑥ Actuator Constraints                → slew / min-cycle shaping        (safety)
      │  commanded outputs
      ▼
HAL (simulated actuators) ──▶ publish post-tick snapshot over MQTT
```

| Stage | Responsibility | Detailed in |
|---|---|---|
| ① Fusion + fault detection | Combine redundant temperature probes; detect stuck/out-of-range sensors; produce trusted values + fault flags | [sensing](./spec-controller-sensing.md) |
| ② Setpoint resolution | Pick the currently active setpoints (e.g. day vs night) | [control loops](./spec-controller-control-loops.md#setpoint-resolution), [config](./spec-controller-config-and-parameters.md) |
| ③ Control loops | Compute desired actuator states from trusted readings + setpoints | [control loops](./spec-controller-control-loops.md) |
| ④ Manual override | Replace desired values for force-flagged actuators | [§6](#6-manual-override) |
| ⑤ Safety interlocks | Unconditionally override outputs on dangerous conditions | [safety](./spec-controller-safety-and-constraints.md#2-safety-interlocks) |
| ⑥ Actuator constraints | Enforce hardware limits (slew, min on/off) on the resolved output | [safety](./spec-controller-safety-and-constraints.md#4-actuator-constraints) |

The **ordering is the design** — see the
[priority model](./spec-controller-safety-and-constraints.md#3-priority--ordering-model):
control loops propose, manual override can replace, safety interlocks have
unconditional final say over both, and actuator constraints shape whatever
survives (so even a safety response respects slew limits).

---

## 3. Real-time & scheduling model

The pipeline runs on a **fixed tick**. The committed values are owned by the NFR
doc; this section describes the model, not the numbers.

| Property | Requirement | Why it matters |
|---|---|---|
| Tick period | `P1-PERF-1` — fixed **1 Hz (1000 ms)** | Deterministic cadence; telemetry and control share one clock |
| Jitter | `P1-PERF-2` — **≤ 50 ms** (5% of period) | Bounds the gap between scheduled and actual tick start |
| Compute budget | `P1-PERF-3` — full pipeline **≤ 100 ms** on one core | Leaves ample headroom inside the period |
| Interlock latency | `P1-REL-1` — a detected condition is acted on **within one tick** | The pipeline runs fault detection → interlocks every tick, so the bound is structural |

Consequences of the fixed-tick model:

- **One clock drives everything.** Telemetry is published once per tick
  (`P1-OBS-1`), setpoint resolution is evaluated per tick, and time-based logic
  (day/night, DLI accumulation, drain periods, override expiry) advances by the
  tick. Nothing is event-driven mid-tick.
- **REST writes are latched, not applied immediately.** An inbound setpoint or
  override edit updates controller state; the next tick reads the new state. This
  keeps each tick a clean snapshot and avoids mid-pipeline mutation.
- **MQTT publish is downstream of the tick**, reflecting the committed outputs and
  state for that tick — never a partial pipeline.

---

## 4. State topology

The controller owns a small, well-bounded set of state. Keeping these distinct is
what lets each tick be reconstructed and each stage stay testable in isolation
(`P1-MAINT-1`).

| State | Owner stage | Lifetime | Examples |
|---|---|---|---|
| **Raw readings** | HAL read | one tick | per-probe temperatures, RH, CO₂, PAR, per-zone VWC |
| **Trusted state** | fusion + fault detection | one tick | fused temperature, validated readings, derived VPD |
| **Fault flags** | fault detection | sticky until cleared | per-sensor stuck/out-of-range/disagreement, alarms |
| **Resolved setpoints** | setpoint resolution | one tick (from config) | active temperature setpoint, humidity band, CO₂ target |
| **Loop state** | control loops | across ticks | PID integrator/derivative terms, hysteresis on/off latch, DLI accumulator, per-zone drain timers |
| **Override state** | manual override | until cleared / expiry | per-actuator force flag, forced value, expiry deadline |
| **Configuration** | startup + REST | until restart / REST edit | setpoints, thresholds, zone defs, HAL params |

Configuration splits into runtime-mutable (setpoints, thresholds, override) and
restart-only (zone topology, HAL τ/coupling) — the boundary is owned by
[config](./spec-controller-config-and-parameters.md#startup-vs-runtime).

---

## 5. Module composition rules

The pipeline stages are cohesive modules behind explicit interfaces, with domain
logic kept separate from infrastructure (per the project
[architecture guidance](../../../../CLAUDE.md)). This is what `P1-MAINT-1` and
`P1-MOD-1` measure.

1. **Each stage is independently testable.** A stage is a function from typed
   inputs to typed outputs; it does no I/O except through the HAL trait. Fusion can
   be tested on synthetic probe arrays, interlocks on synthetic trusted state, etc.
   (`P1-MAINT-1`).
2. **The HAL is a trait, not a concrete simulator.** Control logic depends on the
   trait; the simulated HAL is one implementation. A real-hardware HAL — or the
   Phase 4 combustion-heater HAL — is a new backend, not a rewrite (`P1-MOD-1`,
   [RFC-006](../../../decisions/request-for-comments.md#rfc-006-phase-4-seam-strategy)).
3. **Control targets variables, not actuators.** Loops compute desired *climate
   outcomes*; the mapping to actuator effects lives in the HAL
   ([coupling matrix](./spec-controller-hal-simulation.md)). This keeps the
   coupling in one place and the loops portable.
4. **Infrastructure lives at the edges.** MQTT publishing, REST handling, and
   config loading are infrastructure modules around the pure pipeline core, not
   threaded through it ([interfaces](./spec-controller-interfaces.md),
   [tech stack](./spec-controller-tech-stack.md)).

---

## 6. Manual override

The REST API can force any actuator to a specific state, bypassing its control
loop. Override is **stage ④** of the pipeline: it sits *downstream of the control
loops* (so it replaces their output) but *upstream of safety interlocks* (so it can
never defeat them).

- **Per-actuator force flag + forced value** live in override state. While a flag
  is set, stage ③ still runs but its output for that actuator is discarded and the
  forced value is substituted.
- **Auto-expiry.** Every override carries a configurable timeout; on expiry the
  flag clears and control returns to the loop, so a forgotten override cannot
  strand the greenhouse (`P1-RESIL-2`). An override is also clearable explicitly
  over REST.
- **Published as state.** Active overrides (actuator, value, remaining time) are
  part of the MQTT system-state snapshot ([interfaces](./spec-controller-interfaces.md)).
- **Safety still wins.** Because override is upstream of stage ⑤, a
  critical-temperature or CO₂-ceiling interlock overrides a forced value; an
  operator cannot suppress a safety response
  ([priority model](./spec-controller-safety-and-constraints.md#3-priority--ordering-model)).

The REST surface that manages overrides (set/clear/inspect) is owned by
[interfaces](./spec-controller-interfaces.md); this section owns *where override
sits in the pipeline and how it resolves against everything else*.

---

## 7. Failure modes & degradation

The controller is built to **degrade, not stop**. Most failures are sensor- or
actuator-shaped; the guiding principle is *bias toward the action least likely to
harm the crop, keep controlling on what remains, and surface the fault*. What can
go wrong, how it's detected, and how the pipeline behaves:

| Failure | Detected by | Pipeline behavior / recovery |
|---|---|---|
| One temperature probe deviates | fusion disagreement check | Exclude it; continue on the remaining probes (median). No control degradation with 3 probes (`P1-REL-2`); [sensing](./spec-controller-sensing.md) |
| Down to one trustworthy probe | fusion | Continue controlling on it; raise loss-of-redundancy alarm (`P1-RESIL-1`) |
| Temperature probes in total disagreement | fusion | Treat temperature as unavailable; safety interlock holds a safe state ([safety](./spec-controller-safety-and-constraints.md#2-safety-interlocks)) |
| Non-temperature sensor stuck / out-of-range | fault detection (per-tick) | Apply that sensor's fail-safe (e.g. disable misters, fail-closed injector); flag + alarm (`P1-REL-3`); [sensing](./spec-controller-sensing.md) |
| Actuator has no effect (e.g. valve opens, no moisture change) | per-zone effect check | Disable the affected zone; raise alarm ([safety](./spec-controller-safety-and-constraints.md#2-safety-interlocks)) |
| Dangerous climate condition | safety interlocks (per-tick) | Unconditional override of all loops + override; act within one tick (`P1-REL-1`) |
| Forgotten manual override | override expiry timer | Auto-clear after timeout; control resumes (`P1-RESIL-2`) |

Faults are sticky (they persist until the condition clears), every fault is
mirrored in the REST `/health` surface (`P1-OBS-2`) and published as an MQTT fault
event (`P1-OBS-1`), and a degraded controller keeps running its tick.

---

## 8. Deployment

The controller never runs on a physical device — the
[HAL](./spec-controller-hal-simulation.md) is pure simulation, so there is no
real-hardware path and nothing to run on embedded hardware. The **same binary**
serves both modes with no code change (`P1-PORT-1`); only packaging and config
delivery differ.

- **Phase 1 (standalone):** a **native binary on Windows** (the dev machine),
  configured by a **TOML file** ([config](./spec-controller-config-and-parameters.md))
  passed at startup, with values coming from that file plus direct REST edits.
  There is no platform above it. This is the simplest path for developing and
  testing the control logic.
- **Phase 2 (managed):** the same controller as a **Docker container**, configured
  by a **TOML file mounted at startup**, one container per greenhouse, connecting
  to the platform over the local Docker network. See
  [platform deployment](../platform/spec-platform-operations.md#2-deployment) for the
  named-service / variable-N model.

In both modes the configuration is the same TOML: the controller's unique
`controller_id` (its greenhouse identity when registering with the platform), all
setpoints, HAL simulation parameters, and zone definitions. Each instance is one
independent greenhouse with no shared state. Structural changes (zones, HAL
parameters) require a config edit + restart, consistent with the
[startup-vs-runtime boundary](./spec-controller-config-and-parameters.md#startup-vs-runtime).

The committed resource-footprint, availability, and portability targets are
`P1-PERF-4` (≤ 50 MB resident, ≤ 5% of one core steady-state), `P1-AVAIL-1`
(≥ 99.9% over a continuous run; bounded restart-to-first-tick), and `P1-PORT-1`
(same binary native + container), in the
[NFR doc](../../artifacts/non-functional-requirements.md).

---

## 9. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| Per-stage sensor conditioning | composed | [`spec-controller-sensing.md`](./spec-controller-sensing.md) |
| Per-loop algorithms + dynamics | composed | [`spec-controller-control-loops.md`](./spec-controller-control-loops.md) |
| Interlock priority + actuator constraints | composed | [`spec-controller-safety-and-constraints.md`](./spec-controller-safety-and-constraints.md) |
| Simulation behind the HAL trait | bounded by | [`spec-controller-hal-simulation.md`](./spec-controller-hal-simulation.md) |
| Config + runtime-vs-restart boundary | consumes | [`spec-controller-config-and-parameters.md`](./spec-controller-config-and-parameters.md) |
| MQTT/REST surfaces | exposes via | [`spec-controller-interfaces.md`](./spec-controller-interfaces.md) |
| Dependency choices (runtime, scheduler, frameworks) | referenced | [`spec-controller-tech-stack.md`](./spec-controller-tech-stack.md) |
| Hard rules (determinism, headless, no hardware) | constrained by | [`spec-controller-constraints.md`](./spec-controller-constraints.md) |
| Quality targets (`P1-PERF-*`, `P1-REL-1`, `P1-RESIL-*`, `P1-PORT-1`) | cited | [NFR doc](../../artifacts/non-functional-requirements.md) |
