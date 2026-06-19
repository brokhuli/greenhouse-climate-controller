# Controller — Interfaces

> **Purpose:** Define the controller's two outward surfaces — **MQTT** (telemetry
> out) and the **REST API** (the sole inbound write path) — what each is
> responsible for, and how both bind to the wire contracts without restating them.
> The controller is [headless](#1-the-headless-principle); these surfaces are the
> only way to observe or influence it. Wire-format detail (topic names, payload
> schemas, status codes) is owned by [`contracts/`](../../../../contracts/) under
> the conventions in
> [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format);
> this file lists *responsibilities*, not schemas. The full system contract set is
> catalogued in [`spec-contracts.md`](../spec-contracts.md).

---

## 1. The headless principle

The controller has **no UI of its own**. There is no local dashboard and no
WebSocket stream; the only frontend in the system is the
[Phase 2 platform's](../frontend/01-spec-frontend-overview.md), which monitors one or
more controllers. In standalone Phase 1, the controller is observed directly through
MQTT tooling (e.g. MQTT Explorer) and its REST surface.

| Surface | Direction | Role |
|---|---|---|
| **MQTT** | out (publish) | Sensor readings, actuator states, fault events, consolidated system state — telemetry only |
| **REST API** | in (write) | Setpoint/threshold CRUD, zone status, manual-override management, health — the sole inbound write path; plus a simulated-HAL-only sensor-injection diagnostic surface ([§3](#simulation-control-simulated-hal-only)) |

The split is deliberate and fixed by
[RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain):
telemetry flows out over MQTT; *all* control flows in over REST. The controller
subscribes to **no** command topics.

---

## 2. MQTT — telemetry out

Every tick, the controller publishes a consistent post-tick snapshot
([architecture §3](./02-spec-controller-architecture.md#3-real-time--scheduling-model)):
sensor readings, actuator states (both the **commanded** value and the **observed**
readback from the [HAL](./03-spec-controller-hal-simulation.md#8-observed-actuator-state-and-fault-injection)),
and the consolidated system state (active setpoints, overrides, sensor and actuator
health). Fault and interlock events are published as they occur — including the
[actuator-health faults](./06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring)
(`actuator_stuck`, `actuator_no_response`, `setpoint_unreachable`).

- **Cadence.** Telemetry is published **every tick** (`P1-OBS-1`), giving observers
  a 1 Hz stream aligned to the control clock.
- **Telemetry-only.** MQTT is never a command channel — there are no command topics
  to subscribe to ([spec-contracts §3](../spec-contracts.md#3-not-system-contracts)).
- **Consumers.** The platform ingests it (Phase 2); the optimizer reads the
  resulting history (Phase 3). Both are downstream of the same published surface.
- **Decoupled from control.** Publishing runs on its own task and never blocks the
  tick; broker disconnect/reconnect behavior is [§7](#7-mqtt-connection-resilience)
  (`P1-RESIL-3`).

Topic taxonomy, the payload envelope (`greenhouse_id` identity, timestamp,
`schema_version`), QoS, and retained-message policy are owned by
[`contracts/mqtt/`](../../../../contracts/mqtt/) under
[RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)
and [RFC-001](../../../decisions/request-for-comments.md#rfc-001-mqtt-broker-selection).

---

## 3. REST — the sole write path

The REST API is the only way anything enters the controller. It exposes:

- **Setpoint / threshold CRUD** — read and update the runtime-mutable
  [configuration](./07-spec-controller-config-and-parameters.md#startup-vs-runtime)
  (climate setpoints, per-zone thresholds & schedules). A rejected value names the
  violated bound.
- **Zone status** — per-zone moisture, schedule, and irrigation state.
- **Manual-override management** — set / clear / inspect actuator overrides
  ([§4](#4-manual-override-management)).
- **Health** — every active fault and alarm ([§5](#5-published-shapes--health)).
- **Simulation control** *(simulated HAL only)* — set / clear / inspect
  [sensor-reading injections](./03-spec-controller-hal-simulation.md#9-sensor-reading-injection)
  ([Simulation control](#simulation-control-simulated-hal-only)). A diagnostic/test surface,
  not a production control path.

Writes are **latched, not applied mid-tick**: an edit updates controller state and
takes effect on the next tick
([architecture §3](./02-spec-controller-architecture.md#3-real-time--scheduling-model)).
In managed mode the platform is the sole REST consumer; the frontend reaches the
controller *through* the platform, never directly
([spec-contracts §2.2](../spec-contracts.md#22-controller-rest-api)). The API is
**unauthenticated** — the Docker network is the trust boundary
([RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)).

The path shapes, request/response schemas, and status codes are owned by
[`contracts/controller-rest/`](../../../../contracts/controller-rest/) (OpenAPI
3.1) under
[RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain).

### Simulation control (simulated HAL only)

A diagnostic surface for **creating fault and interlock conditions on demand** — the REST
front for the HAL's
[sensor-reading injection](./03-spec-controller-hal-simulation.md#9-sensor-reading-injection).
It lets an operator (standalone) or a test force a sensor channel to a value — e.g. drive
temperature past the
[critical-temperature interlock](./06-spec-controller-safety-and-constraints.md#2-safety-interlocks)
— and watch the real sensing → interlock path respond, instead of waiting for the plant
dynamics or restarting to retune a disturbance profile.

- **Set / clear / inspect** an injection (sensor channel + forced value + optional timeout),
  mirroring [manual-override management](#4-manual-override-management): latched to the next
  tick, with an **auto-expiry** plus an explicit clear so an injection cannot silently pin a
  variable.
- **Simulated-backend only.** Injection reaches the plant through a simulation-only
  [HAL extension](./03-spec-controller-hal-simulation.md#9-sensor-reading-injection); a
  real-hardware backend, whose readings come from physical sensors, does not implement it, so
  these paths are **rejected (`404`)** there. This is the only REST surface gated to the
  simulated backend.
- **Still REST, still telemetry-out-only over MQTT.** This adds no MQTT command path
  ([§2](#2-mqtt--telemetry-out)); it is an inbound REST surface like every other write. The
  injected value needs no separate reporting — it *is* the sensor reading, so it appears in
  the normal [published shapes](#5-published-shapes--health) for that tick.
- **Not a production path.** In managed mode the platform does **not** call it; it exists for
  standalone diagnostics and the [verification scenarios](./11-spec-controller-verification.md).
  Its path shapes and schemas are owned by
  [`contracts/controller-rest/`](../../../../contracts/controller-rest/) like the rest of the
  surface, tagged simulation-only.

---

## 4. Manual-override management

The REST API is where overrides are created and cleared; the override's *behavior*
in the pipeline (injection point, ordering against safety, auto-expiry) is owned by
[architecture §6](./02-spec-controller-architecture.md#6-manual-override). The surface
here:

- **Set** an override (actuator + forced value + optional timeout).
- **Clear** an override explicitly (it also auto-expires, `P1-RESIL-2`).
- **Inspect** active overrides; they are also published in the MQTT system state.

Forcing an actuator is a **controller-local** action — the platform's downward
control is setpoint-only and does not proxy actuator overrides
([platform constraints](../platform/11-spec-platform-constraints.md#7-scope--deferred--out-of-scope)).

---

## 5. Published shapes & health

What the controller publishes (the shapes the
[frontend data model](../frontend/05-spec-frontend-data-model.md) ultimately consumes,
via the platform): per-metric readings (temperature, humidity, CO₂, PAR, per-zone
soil moisture), actuator states (commanded vs observed, plus a per-actuator health
flag), fault/interlock events, and the consolidated system state.

The REST **`/health`** endpoint reflects **every active fault and alarm**
(`P1-OBS-2`) — the same faults raised by [sensing](./04-spec-controller-sensing.md#6-fault-surfacing),
[safety interlocks](./06-spec-controller-safety-and-constraints.md#2-safety-interlocks),
and [actuator-health monitoring](./06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring)
(stuck / no-response / setpoint-unreachable). A fault is therefore observable through
both surfaces and never silent.

---

## 6. Contract binding

This spec binds to contracts; it does not define them. The two controller-side
contracts both exist today:

| Contract | Location | Status | Governing decision |
|---|---|---|---|
| MQTT telemetry schemas | [`contracts/mqtt/`](../../../../contracts/mqtt/) | Authored | [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format), [RFC-001](../../../decisions/request-for-comments.md#rfc-001-mqtt-broker-selection) |
| Controller REST API | [`contracts/controller-rest/`](../../../../contracts/controller-rest/) | Authored | [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain), [RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries) |

A change to either is versioned and accompanied by an ADR, per
[`contracts/README.md`](../../../../contracts/README.md). The catalog of all system
contracts (including the platform/optimizer ones downstream of this surface) is
[`spec-contracts.md`](../spec-contracts.md).

---

## 7. MQTT connection resilience

Telemetry is the only window into a headless controller, but it must never become a way
to *stop* one. The split that guarantees that: **publishing is decoupled from control**.
The MQTT publisher is a separate task that reads the latched post-tick snapshot
([architecture §3](./02-spec-controller-architecture.md#3-real-time--scheduling-model)); the
control tick hands off a snapshot and moves on. So a slow, blocked, or **disconnected
broker cannot stall the tick** — the controller keeps sensing, deciding, and actuating at
1 Hz regardless of broker state (`P1-RESIL-3`, and the `P1-PERF-*` budgets stay
broker-independent).

- **Bounded outbound buffer.** If the broker stalls, the publisher's outgoing queue is
  **bounded**, not unbounded — under sustained backpressure the oldest per-tick frames are
  dropped rather than accumulated. This is safe because each tick fully supersedes the last:
  the **retained** consolidated state always carries the latest snapshot, so a dropped
  intermediate frame costs history resolution, never current truth.
- **Disconnect is a data gap, not a control failure.** Telemetry produced while the broker
  is unreachable is lost to subscribers but does not affect control; it is a **recoverable
  data gap** (the Phase 2 platform treats the same gap as recoverable, `P2-RESIL-1`).
- **Reconnect re-primes subscribers.** The client auto-reconnects
  ([tech stack](./09-spec-controller-tech-stack.md#messaging)); on reconnect the **retained**
  `gh/{id}/state` snapshot ([contracts/mqtt](../../../../contracts/mqtt/)) gives any
  (re)connecting subscriber current state immediately, and the per-tick streams resume.
- **Staleness is observable.** Every message carries the envelope `ts`
  ([RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)),
  so a consumer can tell a live 1 Hz stream from a stale last-known retained snapshot by its
  timestamp — the controller need not signal liveness separately.

The broker itself (Mosquitto) and the QoS / retained-message policy are owned by
[RFC-001](../../../decisions/request-for-comments.md#rfc-001-mqtt-broker-selection) and
[`contracts/mqtt/`](../../../../contracts/mqtt/); this section owns only how the controller
*behaves* across a broker outage.

---

## 8. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| Override pipeline behavior (vs this REST surface) | managed via | [`02-spec-controller-architecture.md`](./02-spec-controller-architecture.md#6-manual-override) |
| What faults are surfaced (sensor) | reports | [`04-spec-controller-sensing.md`](./04-spec-controller-sensing.md#6-fault-surfacing) |
| Actuator-health faults + observed actuator state | surfaces | [`06-spec-controller-safety-and-constraints.md`](./06-spec-controller-safety-and-constraints.md#5-actuator-health-monitoring) |
| Sensor injection the sim-control surface drives | fronts | [`03-spec-controller-hal-simulation.md`](./03-spec-controller-hal-simulation.md#9-sensor-reading-injection) |
| Runtime-mutable config the REST API edits | edits | [`07-spec-controller-config-and-parameters.md`](./07-spec-controller-config-and-parameters.md#startup-vs-runtime) |
| Wire formats (topics, payloads, status codes) | binds to | [`contracts/`](../../../../contracts/), [`spec-contracts.md`](../spec-contracts.md) |
| Who consumes the telemetry | consumed by | [platform ingestion](../platform/04-spec-platform-ingestion.md), [frontend data model](../frontend/05-spec-frontend-data-model.md) |
| `P1-OBS-1` (per-tick publish), `P1-OBS-2` (health), `P1-RESIL-3` (publish never blocks control) | cited | [NFR doc](../../artifacts/non-functional-requirements.md) |
