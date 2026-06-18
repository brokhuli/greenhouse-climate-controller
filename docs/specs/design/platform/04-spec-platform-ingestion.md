# Platform — Telemetry Ingestion

> **Purpose:** Define how the platform takes telemetry **up** from the controllers —
> the MQTT subscription, per-greenhouse routing, the streams it stores, liveness
> derivation, and the retention policy that keeps an append-only store bounded.
> Wire formats (topic taxonomy, payload envelope, QoS, retained policy) are owned by
> [`contracts/mqtt`](../../../../contracts/mqtt/) under
> [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format);
> this file lists *responsibilities*, not schemas.

This is the **telemetry-up** half of the platform's bidirectional model
([overview §1](./01-spec-platform-overview.md#1-what-the-platform-is)); the
**control-down** half is [crop profiles](./05-spec-platform-crop-profiles.md).

---

## 1. Subscribe and store

The API subscribes to the controllers' MQTT topics (topic map defined in
[`contracts/mqtt`](../../../../contracts/mqtt/), following the taxonomy and envelope
fixed by RFC-007) and writes what it receives into the time-series store
([data model](./03-spec-platform-data-model.md)). Ingestion is the platform's only
inbound path from the greenhouses.

---

## 2. Per-greenhouse routing

Each controller publishes under its own `gh/{greenhouse_id}/...` topic root (RFC-007);
the ingester wildcard-subscribes and maps topic → greenhouse via the registry's
controller-endpoint record, keyed by the same `greenhouse_id`. The registry
([fleet management](./05-spec-platform-crop-profiles.md#5-fleet-management--operator-control))
is the bootstrap that routing keys off — an unregistered `greenhouse_id` has nowhere
to land and is rejected/logged rather than silently stored.

---

## 3. Streams ingested

The same surface the controller publishes
([controller interfaces](../controller/08-spec-controller-interfaces.md)):

- **Sensor readings** — fused/raw per-metric values (temperature, humidity, CO₂, PAR,
  per-zone soil moisture).
- **Actuator states** — commanded and observed positions.
- **Fault / state events** — faults, safety-interlock activations, and the
  consolidated system state.

---

## 4. QoS, retained & liveness

- **QoS & retained** — readings use the QoS the contract specifies; the retained
  system-state message lets the platform recover a controller's current state on
  (re)connect without waiting for the next sample.
- **Liveness / health** — absence of expected messages marks a
  greenhouse **offline**; ingested fault events mark it **degraded**. Per-greenhouse
  status is derived *here* and surfaced to the fleet view and reconciliation
  ([crop profiles](./05-spec-platform-crop-profiles.md)). Liveness is therefore a product
  of ingestion, not a separate poll.

---

## 5. Retention & downsampling

Telemetry is append-only and grows without bound, so the time-series store needs a
**retention policy** (and optionally continuous aggregates / downsampling for
long-range dashboard queries). The specific horizon is an implementation/config
choice, not fixed by this spec; TimescaleDB's retention + continuous-aggregate
features are the intended mechanism ([data model](./03-spec-platform-data-model.md)).

---

## 6. Ingest backpressure & load-shedding

Ingestion is decoupled from the database write the same way the controller decouples
publishing from its control tick
([controller interfaces §7](../controller/08-spec-controller-interfaces.md#7-mqtt-connection-resilience))
— here in the **up** direction:

- **Bounded buffer.** A buffer sits between MQTT receipt and the time-series write; it
  is **bounded**, not unbounded. The store keeping up is the normal case (`P2-PERF-1`:
  the full MQTT topic fan-out for 50 controllers at 1 Hz with no backlog growth; `P2-PERF-4`:
  < 1 s write latency).
- **Shed oldest under sustained backpressure.** If the write path slows enough that the
  buffer fills, the ingester **drops the oldest frames per greenhouse** rather than
  accumulating until it exhausts memory. Load-shedding is bounded and local — never an
  OOM that takes the hub down.
- **Why dropping is safe.** Each reading fully supersedes the last, and the retained
  consolidated `state` topic always carries current truth, so a shed intermediate frame
  costs **history resolution, not current state or control**. This is the same
  *recoverable data gap, not a control failure* that `P2-RESIL-1` already sanctions for
  platform downtime — backpressure shedding is that gap under live load.
- **Shedding is observable.** A filling buffer shows up as the ingestion **lag/backlog**
  metric ([operations §1](./08-spec-platform-operations.md#1-observability)); sustained
  shedding is the signal that the store is the bottleneck, surfaced before any loss is
  silent.

---

## 7. Read-only with respect to the greenhouse

Ingestion **never changes a controller**. All downward writes go through the control
path in [crop profiles](./05-spec-platform-crop-profiles.md). This one-way property is
what lets ingestion wildcard-subscribe to the whole fleet without any risk of a
side effect on a greenhouse.

---

## 8. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| Where ingested telemetry is stored | writes to | [`03-spec-platform-data-model.md`](./03-spec-platform-data-model.md) |
| How derived status feeds the fleet view + reconciliation | feeds | [`05-spec-platform-crop-profiles.md`](./05-spec-platform-crop-profiles.md) |
| The lag/backlog metric that surfaces shedding | surfaced by | [operations §1](./08-spec-platform-operations.md#1-observability) |
| The published surface being ingested | consumes | [controller interfaces](../controller/08-spec-controller-interfaces.md) |
| Topic taxonomy, envelope, QoS, retained policy | defers to | [`contracts/mqtt`](../../../../contracts/mqtt/), [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format) |
