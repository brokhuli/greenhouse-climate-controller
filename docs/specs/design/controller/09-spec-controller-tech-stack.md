# Controller — Tech Stack

> **Purpose:** The recommended controller dependency set, going one level deeper
> than [tech-stack-decisions.md](../tech-stack-decisions.md#phase-1--deterministic-greenhouse-controller),
> which fixes the load-bearing choices. Each entry states **what** it
> is, **why** it's chosen over alternatives, and **how** it's used here. Choices are
> constrained by the [NFR doc](../../artifacts/non-functional-requirements.md)
> (`P1-PERF-*` real-time budget, `P1-TEST-1/2` coverage + determinism, `P1-PORT-1`
> native+container) and the
> [constraints](./10-spec-controller-constraints.md). Host tooling (broker install,
> editors) is in
> [`required-dependencies.md`](../required-dependencies.md#phase-1--greenhouse-climate-controller).

> **Discretionary picks are flagged ⚑** — the control-math implementation and the
> tick-scheduling approach are the two choices most worth a second look; the rest
> are fixed upstream.

---

## Core language & runtime

### Rust — `rustc`, `cargo`

- **What:** Systems language with memory safety and no GC.
- **Why:** Fixed by [tech-stack-decisions.md](../tech-stack-decisions.md#phase-1--deterministic-greenhouse-controller).
  No GC pauses is what makes the `P1-PERF-2` jitter bound (≤ 50 ms) and the
  `P1-PERF-3` compute budget (≤ 100 ms) realistic; the type system carries the
  [explicit stage interfaces](./02-spec-controller-architecture.md#5-module-composition-rules)
  (`P1-MAINT-1`).
- **How:** One binary, the same one native and in Docker (`P1-PORT-1`). Pipeline
  stages are plain functions over typed state; the HAL is a trait.

### Tokio — `tokio`

- **What:** Async runtime.
- **Why:** Fixed upstream; Tokio-native MQTT/HTTP crates (`rumqttc`, `axum`) build
  on it. The controller's concurrency is modest — a tick timer, the MQTT client
  task, and the REST server task — which Tokio handles without extra machinery.
- **How:** The control pipeline runs on a periodic timer; the MQTT publisher and the
  REST server run as concurrent tasks that communicate with the pipeline through
  latched state, never by mutating it mid-tick
  ([architecture §3](./02-spec-controller-architecture.md#3-real-time--scheduling-model)).

---

## Messaging

### MQTT client — `rumqttc` (broker: Mosquitto)

- **What:** Pure-Rust, Tokio-native MQTT client.
- **Why:** The broker (Mosquitto) is fixed by
  [RFC-001](../../../decisions/request-for-comments.md#rfc-001-mqtt-broker-selection);
  `rumqttc` is the Tokio-native client recorded at Cargo bootstrap. MQTT gives QoS
  and retained messages for free, which suit per-tick telemetry.
- **How:** Publishes the post-tick snapshot and fault events
  ([interfaces §2](./08-spec-controller-interfaces.md#2-mqtt--telemetry-out)); subscribes
  to nothing (telemetry-only). Topic taxonomy and envelope are owned by
  [`contracts/mqtt/`](../../../../contracts/mqtt/). The client runs on its **own task**
  with a **bounded** outbound queue and `rumqttc`'s built-in **auto-reconnect**, so a slow
  or disconnected broker applies backpressure to the publisher — never to the control tick
  ([interfaces §7](./08-spec-controller-interfaces.md#7-mqtt-connection-resilience), `P1-RESIL-3`).

---

## REST API

### axum — `axum`

- **What:** Tokio-native web framework.
- **Why:** Recorded at Cargo bootstrap alongside `rumqttc`; shares the runtime, so
  the REST server is one more task rather than a second stack. The controller's API
  is small (setpoints, zones, override, health), which axum's extractor/handler
  model fits without ceremony.
- **How:** Serves the
  [controller REST surface](./08-spec-controller-interfaces.md#3-rest--the-sole-write-path);
  handlers latch writes into controller state. The contract is
  [`contracts/controller-rest/`](../../../../contracts/controller-rest/) (OpenAPI
  3.1); the server is unauthenticated by default, with an optional per-controller bearer token for
  hardened deployments
  ([RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009),
  superseding [RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)).

---

## Hardware abstraction

### HAL traits + simulated backend

- **What:** A trait defining sensor reads + actuator commands, with a simulated
  implementation.
- **Why:** The seam that keeps control logic hardware-agnostic and makes a real (or
  Phase 4 combustion-heater) backend a new impl, not a rewrite (`P1-MOD-1`,
  [RFC-006](../../../decisions/request-for-comments.md#rfc-006-phase-4-seam-strategy)).
- **How:** The pipeline depends on the trait; the
  [simulated backend](./03-spec-controller-hal-simulation.md) is one implementation,
  seeded for determinism (`P1-TEST-2`). The trait returns, per actuator, both the
  **commanded** value and an **observed** readback
  ([HAL §8](./03-spec-controller-hal-simulation.md#8-observed-actuator-state-and-fault-injection))
  so the [actuator-health monitor](./06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring)
  can detect stuck/no-response faults the same way against any backend (`P1-REL-4`).

---

## Configuration

### serde + toml — `serde`, `toml`

- **What:** Deserialization framework + TOML parser.
- **Why:** TOML is the chosen config format
  ([config](./07-spec-controller-config-and-parameters.md)); `serde` + `toml` map it to
  typed config structs with validation at the boundary, so a bad config fails at
  load, not mid-tick.
- **How:** Config structs deserialize at startup; runtime REST edits validate
  against the same types (a rejected value names the violated bound).

---

## Control math ⚑

### PID — hand-rolled vs crate

- **What:** The temperature [PID controller](./05-spec-controller-control-loops.md#fast-loops--reactive).
- **Why ⚑:** A PID with anti-windup and mode switching is ~tens of lines and is the
  most safety-relevant, most-tested code in the system (`P1-TEST-1`). Hand-rolling
  keeps it auditable and dependency-free; a crate (e.g. `pid`) saves little and adds
  a surface to vet. **Trip-wire:** reach for a crate only if gain-scheduling or
  cascaded loops grow beyond what's readable inline.
- **How:** Implemented in the control-loop module with integral clamping; gains come
  from [config](./07-spec-controller-config-and-parameters.md#default-parameters-reference).

---

## Tick scheduling ⚑

- **What:** The fixed 1 Hz pipeline clock (`P1-PERF-1`).
- **Why ⚑:** A `tokio::time::interval` with `MissedTickBehavior` set to skip-and-warn
  meets the cadence and lets jitter be *measured* against `P1-PERF-2` (≤ 50 ms)
  rather than assumed. A dedicated real-time scheduler is unwarranted on a simulated,
  non-embedded target. **Trip-wire:** revisit only if measured jitter approaches the
  bound under load.
- **How:** The interval drives the pipeline; each tick records its compute time so
  `P1-PERF-3` (≤ 100 ms) is observable, and overruns are logged rather than silently
  absorbed.

---

## Testing

- **What:** `cargo test` unit/integration tests + a deterministic-seed simulation
  harness.
- **Why:** `P1-TEST-1` requires ≥ 90% line coverage on the control-loop and
  safety-interlock modules; `P1-TEST-2` requires the HAL to be deterministic under a
  fixed seed. Determinism is what makes loop/interlock assertions stable
  ([HAL §7](./03-spec-controller-hal-simulation.md#7-determinism--seeding)).
- **How:** Stages are tested as pure functions over synthetic state; whole-run tests
  drive the seeded HAL and assert plant response. `proptest` is optional for
  fusion/fault-detection edge cases (random probe arrays). Coverage runs in CI.

---

## Tooling

- **rustfmt** — formatting; canonical so diffs stay meaningful.
- **clippy** — lints; runs in CI.
- **Pinned toolchain** (`rust-toolchain.toml`) for reproducible native + container
  builds (`P1-PORT-1`).

---

## Explicitly rejected

Recorded so the choice isn't re-litigated:

- **A second async stack for HTTP (e.g. `actix-web`)** — `axum` already shares the
  Tokio runtime with `rumqttc`; a second executor model adds weight for nothing.
- **An embedded/`no_std` or RTOS target** — the HAL is pure simulation and never
  runs on a device ([constraints](./10-spec-controller-constraints.md#5-hal-swappable--no-real-hardware));
  real-time-OS machinery would be cost with no payoff.
- **MQTT as a command channel** — telemetry-only; setpoints arrive over REST
  ([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)).
- **A heavyweight PID/control crate as default** — see Control math ⚑.
