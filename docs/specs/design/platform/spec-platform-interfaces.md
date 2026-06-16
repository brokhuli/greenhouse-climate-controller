# Platform — Interfaces & Integration with Phase 1

> **Purpose:** Define the three cross-component interfaces the platform sits across —
> MQTT up from the controllers, controller REST down to them, and WebSockets out to
> the frontend — and bind them to the contracts that own their wire formats. This file
> lists *which interface does what*; topic maps, REST shapes, and message schemas are
> owned by [`contracts/`](../../../../contracts/) and the
> [controller interfaces](../controller/spec-controller-interfaces.md) spec, under the
> conventions in
> [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).

---

## 1. The three interfaces

| Interface | Direction | Role |
|---|---|---|
| **MQTT** | Controller → platform | Telemetry ingest: readings, actuator states, fault/state events |
| **Controller REST** | Platform → controller | Setpoint resolution (profile apply/reconcile) + ad-hoc setpoint edits |
| **WebSockets** | Platform → frontend | Live fan-out of telemetry, status, drift, events |

Each maps to one of the platform's [data flows](./spec-platform-architecture.md#3-three-data-flows):
MQTT is the **up** flow ([ingestion](./spec-platform-ingestion.md)), controller REST is
the **down** flow ([crop profiles](./spec-platform-crop-profiles.md)), and WebSockets is
the **dashboard** flow ([API surface](./spec-platform-api-surface.md)).

---

## 2. Telemetry-only over MQTT, all control over REST

Consistent with
[RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format),
MQTT is **telemetry-only** (controller → platform); there are no command topics. All
setpoint writes go over the controller REST API
([RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)).
This keeps the two directions on separate transports with separate trust and delivery
semantics, and mirrors the controller's own
[headless contract](../controller/spec-controller-interfaces.md#1-the-headless-principle).

When Phase 3 lands, the optimizer does **not** add a fourth interface to the
controller: it submits refined targets through the platform's own setpoint write path
([crop profiles §4](./spec-platform-crop-profiles.md#4-boundary-with-phase-3--single-setpoint-authority)),
and the platform remains the sole party speaking the controller REST API.

---

## 3. Contract ownership

The MQTT topic map and the controller REST shapes the platform depends on are owned by
[`contracts/`](../../../../contracts/) and the
[controller interfaces](../controller/spec-controller-interfaces.md) spec; this file
**consumes** those contracts rather than defining them. The full catalog of system
contracts — every cross-component boundary, including the platform's own API surface —
is [`spec-contracts.md`](../spec-contracts.md).

---

## 4. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| MQTT-up flow behavior | frames | [`spec-platform-ingestion.md`](./spec-platform-ingestion.md) |
| Controller-REST-down flow behavior | frames | [`spec-platform-crop-profiles.md`](./spec-platform-crop-profiles.md) |
| WebSocket fan-out to the frontend | frames | [`spec-platform-api-surface.md`](./spec-platform-api-surface.md) |
| The controller surfaces being integrated | integrates | [controller interfaces](../controller/spec-controller-interfaces.md) |
| Wire formats (topics, REST shapes, schemas) | defers to | [`contracts/`](../../../../contracts/), [`spec-contracts.md`](../spec-contracts.md) |
| Topic/identity/envelope conventions; setpoint-delivery chain | defers to | [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format), [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) |
