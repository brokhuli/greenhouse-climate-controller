# Controller — Architecture

> **Purpose:** Describe how the controller is structured at the system level — the
> HAL boundary, the **fixed-tick pipeline** and the data that flows between its
> stages, the real-time/scheduling model, the controller's internal state
> topology, module composition rules, **manual override**, the failure/degradation
> modes, and the deployment shapes. Sits one level above the per-stage detail in
> [HAL simulation](./03-spec-controller-hal-simulation.md),
> [sensing](./04-spec-controller-sensing.md),
> [control loops](./05-spec-controller-control-loops.md), and
> [safety & constraints](./06-spec-controller-safety-and-constraints.md). Read this to
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
   one module ([HAL simulation](./03-spec-controller-hal-simulation.md), `P1-MOD-1`).
2. **The external surface observes and configures; it never reaches into the
   pipeline mid-tick.** MQTT publishes a consistent post-tick snapshot; REST writes
   land in controller state and take effect on the *next* tick
   ([interfaces](./08-spec-controller-interfaces.md)). There is no command path over
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
| ① Fusion + fault detection | Combine redundant temperature probes; detect stuck/out-of-range sensors; produce trusted values + fault flags | [sensing](./04-spec-controller-sensing.md) |
| ② Setpoint resolution | Pick the currently active setpoints (e.g. day vs night temperature) and derive the humidity target from `vpd_target_kpa` + fused temperature, clamped to the humidity safety bounds | [control loops](./05-spec-controller-control-loops.md#setpoint-resolution), [config](./07-spec-controller-config-and-parameters.md) |
| ③ Control loops | Compute desired actuator states from trusted readings + setpoints | [control loops](./05-spec-controller-control-loops.md) |
| ④ Manual override | Replace desired values for force-flagged actuators | [§6](#6-manual-override) |
| ⑤ Safety interlocks | Unconditionally override outputs on dangerous conditions | [safety](./06-spec-controller-safety-and-constraints.md#2-safety-interlocks) |
| ⑥ Actuator constraints | Enforce hardware limits (slew, min on/off) on the resolved output | [safety](./06-spec-controller-safety-and-constraints.md#4-actuator-constraints) |

Fault detection in the tick has an **output-side** half as well as the sensor half. With
stage ①, an [actuator-health check](./06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring)
compares the **previous** tick's commanded outputs against this tick's **observed**
actuator readback ([HAL §8](./03-spec-controller-hal-simulation.md#8-observed-actuator-state-and-fault-injection))
and the trusted readings, raising actuator-fault flags that the loops consume (stage ③
suspends a faulted actuator) and the interlocks act on (stage ⑤ disables it). It is the
only cross-tick comparison in the pipeline; everything else within a tick is forward-only.

The **ordering is the design** — see the
[priority model](./06-spec-controller-safety-and-constraints.md#3-priority--ordering-model):
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
| **Fault flags** | fault detection | sticky until cleared | per-sensor stuck/out-of-range/disagreement; per-actuator stuck/no-response/saturation; alarms |
| **Resolved setpoints** | setpoint resolution | one tick (from config) | active temperature setpoint, derived humidity target (clamped RH from VPD + temp), CO₂ target |
| **Loop state** | control loops | across ticks | PID integrator/derivative terms, hysteresis on/off latch, DLI accumulator, per-zone drain timers |
| **Override state** | manual override | until cleared / expiry | per-actuator force flag, forced value, expiry deadline |
| **Configuration** | startup + REST | until restart / REST edit | setpoints, thresholds, zone defs, HAL params |

Configuration splits into runtime-mutable (setpoints, thresholds, override) and
restart-only (zone topology, HAL τ/coupling) — the boundary is owned by
[config](./07-spec-controller-config-and-parameters.md#startup-vs-runtime).

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
   ([coupling matrix](./03-spec-controller-hal-simulation.md)). This keeps the
   coupling in one place and the loops portable.
4. **Infrastructure lives at the edges.** MQTT publishing, REST handling, and
   config loading are infrastructure modules around the pure pipeline core, not
   threaded through it ([interfaces](./08-spec-controller-interfaces.md),
   [tech stack](./09-spec-controller-tech-stack.md)).

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
  part of the MQTT system-state snapshot ([interfaces](./08-spec-controller-interfaces.md)).
- **Safety still wins.** Because override is upstream of stage ⑤, a
  critical-temperature or CO₂-ceiling interlock overrides a forced value; an
  operator cannot suppress a safety response
  ([priority model](./06-spec-controller-safety-and-constraints.md#3-priority--ordering-model)).

The REST surface that manages overrides (set/clear/inspect) is owned by
[interfaces](./08-spec-controller-interfaces.md); this section owns *where override
sits in the pipeline and how it resolves against everything else*.

---

## 7. Failure modes & degradation

The controller is built to **degrade, not stop**. Most failures are sensor- or
actuator-shaped; the guiding principle is *bias toward the action least likely to
harm the crop, keep controlling on what remains, and surface the fault*. What can
go wrong, how it's detected, and how the pipeline behaves:

| Failure | Detected by | Pipeline behavior / recovery |
|---|---|---|
| One temperature probe deviates | fusion disagreement check | Exclude it; continue on the remaining probes (median). No control degradation with 3 probes (`P1-REL-2`); [sensing](./04-spec-controller-sensing.md) |
| Down to one trustworthy probe | fusion | Continue controlling on it; raise loss-of-redundancy alarm (`P1-RESIL-1`) |
| Temperature probes in total disagreement | fusion | Treat temperature as unavailable; safety interlock holds a safe state ([safety](./06-spec-controller-safety-and-constraints.md#2-safety-interlocks)) |
| Non-temperature sensor stuck / out-of-range | fault detection (per-tick) | Apply that sensor's fail-safe (e.g. disable misters, fail-closed injector); flag + alarm (`P1-REL-3`); [sensing](./04-spec-controller-sensing.md) |
| Actuator no-response (commanded change, no climate effect) | actuator-health effect check (`P1-REL-4`) | Disable the actuator — the zone, for irrigation; raise alarm ([safety §5](./06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring)) |
| Actuator stuck / jammed (observed diverges from commanded) | actuator-health feedback check (`P1-REL-4`) | Disable the actuator; raise alarm ([safety §5](./06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring)) |
| Actuator saturated (pinned at its limit, setpoint unreachable) | loop saturation check | Keep controlling at the limit; raise alarm — never disable ([control-loops](./05-spec-controller-control-loops.md#saturation--setpoint-unreachable)) |
| Dangerous climate condition | safety interlocks (per-tick) | Unconditional override of all loops + override; act within one tick (`P1-REL-1`); clear only after re-arm hysteresis + dwell ([safety §2](./06-spec-controller-safety-and-constraints.md#assert-and-clear-re-arm-hysteresis)) |
| Forgotten manual override | override expiry timer | Auto-clear after timeout; control resumes (`P1-RESIL-2`) |

Faults are sticky (they persist until the condition clears), every fault is
mirrored in the REST `/health` surface (`P1-OBS-2`) and published as an MQTT fault
event (`P1-OBS-1`), and a degraded controller keeps running its tick.

---

## 8. Deployment

The controller never runs on a physical device — the
[HAL](./03-spec-controller-hal-simulation.md) is pure simulation, so there is no
real-hardware path and nothing to run on embedded hardware. The **same binary**
serves both modes with no code change (`P1-PORT-1`); only packaging and config
delivery differ.

- **Phase 1 (standalone):** a **native binary on Windows** (the dev machine),
  configured by a **TOML file** ([config](./07-spec-controller-config-and-parameters.md))
  passed at startup, with values coming from that file plus direct REST edits.
  There is no platform above it. This is the simplest path for developing and
  testing the control logic. For the `P1-AVAIL-1` restart guarantee to hold here it
  must run under a **Windows service wrapper** (NSSM / WinSW), not as a bare process —
  see [§9](#9-availability-restart--resource-footprint).
- **Phase 2 (managed):** the same controller as a **Docker container**, configured
  by a **TOML file mounted at startup**, one container per greenhouse, connecting
  to the platform over the local Docker network. See
  [platform deployment](../platform/08-spec-platform-operations.md#2-deployment) for the
  named-service / variable-N model.

In both modes the configuration is the same TOML: the controller's unique
`controller_id` (its greenhouse identity when registering with the platform), all
setpoints, HAL simulation parameters, and zone definitions. Each instance is one
independent greenhouse with no shared state. Structural changes (zones, HAL
parameters) require a config edit + restart, consistent with the
[startup-vs-runtime boundary](./07-spec-controller-config-and-parameters.md#startup-vs-runtime).

The portability target `P1-PORT-1` (same binary native + container) is satisfied
by this single-binary, config-only deployment model; the availability and
resource-footprint targets (`P1-AVAIL-1`, `P1-PERF-4`) are covered in
[§9](#9-availability-restart--resource-footprint). All are owned by the
[NFR doc](../../artifacts/non-functional-requirements.md).

---

## 9. Availability, restart & resource footprint

Two runtime-quality targets are owned by the
[NFR doc](../../artifacts/non-functional-requirements.md) and made achievable by
choices made elsewhere in this set; this section names the mechanisms so each
target traces to a design rather than being asserted on its own.

### Availability & restart (`P1-AVAIL-1`)

Target: **≥ 99.9% availability** over a continuous run, **restart-to-first-tick
< 5 s**.

The controller stays available by **degrading rather than stopping**
([§7](#7-failure-modes--degradation)): sensor and actuator faults move it down the
degradation ladder but never terminate the process, so the common failure classes
cost no availability. The cases that *do* end the process — a panic, or an
operator/OS/Docker restart — are all handled by one fast cold-start path:

- **No persistent state to recover.** All across-tick state
  ([§4](#4-state-topology)) — loop integrators, fault flags, override deadlines —
  is in-memory and reconstructable. A restart reloads the TOML
  [config](./07-spec-controller-config-and-parameters.md), re-initializes the HAL,
  opens the MQTT and REST tasks, and begins ticking; there is no database to replay
  and no snapshot to restore. That absence is what keeps restart-to-first-tick
  inside the 5 s bound.
- **Faults re-derive themselves.** Because fault detection runs every tick over
  live readings ([§7](#7-failure-modes--degradation),
  [sensing §4](./04-spec-controller-sensing.md#4-fault-detection-non-temperature-sensors)),
  a fault that was active before a restart is re-detected within its detection
  window rather than needing to survive the restart.
- **Restart is external, not self-managed.** The process does not supervise itself, so
  the `P1-AVAIL-1` auto-restart target has a precondition: **an external supervisor must
  be configured.** In managed mode that is Docker's `restart:` policy; in standalone
  mode it is a **Windows service wrapper** (e.g. NSSM or WinSW) that runs the binary as
  a service — *not* a bare double-click of the executable, which has nothing to restart
  it. Wiring up that supervisor is a **deployment responsibility** ([§8](#8-deployment));
  absent it, restart is manual and the availability target does not hold. The
  controller's own responsibility is only to come up fast and idempotently from its
  config — the same input in both modes.

### Resource footprint (`P1-PERF-4`)

Target: **≤ 50 MB resident**, **≤ 5% of one core** steady-state.

The footprint follows from the runtime model rather than from tuning:

- **Bounded per-tick work.** The pipeline runs to completion once per second within
  the `P1-PERF-3` compute budget ([§3](#3-real-time--scheduling-model)) and then
  idles until the next tick, so steady-state CPU is one short burst per second —
  comfortably under 5% of a core.
- **Small, fixed state.** The [state topology](#4-state-topology) is a small,
  well-bounded set with no unbounded growth; the simulated HAL holds a handful of
  scalar variables per zone, not a physics mesh
  ([HAL §6](./03-spec-controller-hal-simulation.md#6-bounded-fidelity)).
- **No GC, modest concurrency.** Rust's no-GC model
  ([tech stack](./09-spec-controller-tech-stack.md)) removes heap-churn headroom, and
  the process is one tick task plus the MQTT and REST tasks — not a
  thread-per-connection server.

Together these keep a single controller light enough that 20–50 run concurrently on
one dev machine, which is the basis for the Phase 2 scalability target
(`P2-SCAL-1`).

---

## 10. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| Per-stage sensor conditioning | composed | [`04-spec-controller-sensing.md`](./04-spec-controller-sensing.md) |
| Per-loop algorithms + dynamics | composed | [`05-spec-controller-control-loops.md`](./05-spec-controller-control-loops.md) |
| Interlock priority + actuator constraints + actuator health | composed | [`06-spec-controller-safety-and-constraints.md`](./06-spec-controller-safety-and-constraints.md) |
| Simulation behind the HAL trait | bounded by | [`03-spec-controller-hal-simulation.md`](./03-spec-controller-hal-simulation.md) |
| Config + runtime-vs-restart boundary | consumes | [`07-spec-controller-config-and-parameters.md`](./07-spec-controller-config-and-parameters.md) |
| MQTT/REST surfaces | exposes via | [`08-spec-controller-interfaces.md`](./08-spec-controller-interfaces.md) |
| Dependency choices (runtime, scheduler, frameworks) | referenced | [`09-spec-controller-tech-stack.md`](./09-spec-controller-tech-stack.md) |
| Hard rules (determinism, headless, no hardware) | constrained by | [`10-spec-controller-constraints.md`](./10-spec-controller-constraints.md) |
| Quality targets (`P1-PERF-*`, `P1-REL-1`, `P1-RESIL-*`, `P1-AVAIL-1`, `P1-PORT-1`) | cited | [NFR doc](../../artifacts/non-functional-requirements.md) |
