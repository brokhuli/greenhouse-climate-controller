# Controller REST Contract

The Phase 1 controller's REST configuration and control surface — the **single source of
truth** for the HTTP API the Phase 2 platform (Go) calls as a client and the controller (Rust)
serves. The normative artifact is [`openapi.json`](./openapi.json) (OpenAPI 3.1, which uses the
JSON Schema 2020-12 dialect — the same dialect as the [MQTT contract](../mqtt/), per
[RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)).

**This is the only write path into the controller.** MQTT is telemetry-only; setpoints reach the
controller here, with **Phase 2 as the single authority** that calls this API
([RFC-005](../../docs/decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)).
One controller process serves exactly one greenhouse.

## File layout

The document is split into navigable sections; [`openapi.json`](./openapi.json) is the entry
point and `$ref`s out to the rest:

```
openapi.json                 # info, servers, and the paths index (one $ref per path)
paths/                       # one file per path
  setpoints.json             #   /setpoints              (GET, PATCH)
  zones.json                 #   /zones                  (GET)
  zone-by-id.json            #   /zones/{zone_id}        (GET, PATCH)
  overrides.json             #   /overrides              (GET)
  override-by-actuator.json  #   /overrides/{actuator}   (PUT, DELETE)
  health.json                #   /health                 (GET)
  sim-sensor-injections.json #   /sim/sensor-injections          (GET)        — sim-only
  sim-sensor-injection-by-metric.json # /sim/sensor-injections/{metric} (PUT, DELETE) — sim-only
  sim-time-scale.json        #   /sim/time-scale         (GET, PUT)   — sim-only
components/
  schemas/                   # request/response body schemas, one file per resource
    setpoints.json           #   Setpoints, SetpointsPatch
    zones.json               #   ZoneConfig, ZoneConfigPatch, ZoneStatus
    overrides.json           #   Override, OverridePut
    health.json              #   Health, FaultSummary
    sim.json                 #   InjectableMetric, SensorInjectionPut, SensorInjection, TimeScalePut, TimeScale (sim-only)
    actuator.json            #   ActuatorName, ActuatorOutputState (shared)
    common.json              #   Slug, Error, ValidationError (shared)
  parameters.json            # shared path/query parameters
  responses.json             # shared error responses (404, 422)
examples/                    # fixtures used as tests (see below)
redocly.yaml                 # lint config
```

References are relative: a path file points at `../components/schemas/setpoints.json#/Setpoints`,
and the schema files cross-reference siblings (e.g. `zones.json` → `./common.json#/Slug`,
`overrides.json` → `./actuator.json#/ActuatorOutputState`). Any OpenAPI 3.1 tool that follows
`$ref`s (Redocly, Swagger UI, most codegen) reads `openapi.json` directly; `redocly bundle`
collapses the tree into a single self-contained file for a tool that wants one.

## Endpoint map

All paths are greenhouse-scoped under `/greenhouses/{greenhouse_id}`.

| Method + path | Purpose | Success | Errors |
|---|---|---|---|
| `GET /setpoints` | Current global climate setpoints | 200 `Setpoints` | 404 |
| `PATCH /setpoints` | Runtime setpoint update (Phase 2 / operator) | 200 `Setpoints` | 422, 404 |
| `GET /zones` | All irrigation zones' live status | 200 `ZoneStatus[]` | 404 |
| `GET /zones/{zone_id}` | One zone's live status | 200 `ZoneStatus` | 404 |
| `PATCH /zones/{zone_id}` | Update zone thresholds/schedule | 200 `ZoneStatus` | 422, 404 |
| `GET /overrides` | Active manual overrides | 200 `Override[]` | 404 |
| `PUT /overrides/{actuator}` | Force an actuator (manual override) | 200 `Override` | 422, 404 |
| `DELETE /overrides/{actuator}` | Clear an override | 204 | 404 |
| `GET /health` | Controller mode, healthy flag, active faults | 200 `Health` | — |
| `GET /sim/sensor-injections` | Active sensor-reading injections *(sim-only)* | 200 `SensorInjection[]` | 404 |
| `PUT /sim/sensor-injections/{metric}` | Inject a sensor reading *(sim-only)* | 200 `SensorInjection` | 422, 404 |
| `DELETE /sim/sensor-injections/{metric}` | Clear a sensor injection *(sim-only)* | 204 | 404 |
| `GET /sim/time-scale` | Current simulated-clock speed + tick *(sim-only)* | 200 `TimeScale` | 404 |
| `PUT /sim/time-scale` | Set the simulated-clock speed (0.25–32×) *(sim-only)* | 200 `TimeScale` | 422, 404 |

Only the runtime-mutable surfaces accept writes. Adding or removing a zone, and changing HAL
parameters, is a config-file edit plus restart (controller spec
[§4](../../docs/specs/design/controller/07-spec-controller-config-and-parameters.md)) — there is
deliberately no `POST`/`DELETE` for zones.

The `/sim/sensor-injections` paths are a **simulation-only** diagnostic surface (tagged
`simulation`, marked `x-simulation-only`): they force a sensor channel to a value so a fault or
interlock condition can be created on demand — e.g. drive temperature past the critical max and
watch the interlock fire (controller
[HAL §9](../../docs/specs/design/controller/03-spec-controller-hal-simulation.md#9-sensor-reading-injection),
[interfaces §3](../../docs/specs/design/controller/08-spec-controller-interfaces.md#simulation-control-simulated-hal-only)).
The injection reaches the plant through a simulation-only HAL extension, so a real-hardware
backend returns **404** on these paths; the Phase 2 platform does **not** call them. Adding this
surface is **additive**, so `info.version` stays at major 1 (see [Versioning](#versioning)).

The `/sim/time-scale` paths are the same kind of **simulation-only** surface: they read and set the
speed of the controller's simulated clock (controller
[HAL §7](../../docs/specs/design/controller/03-spec-controller-hal-simulation.md#7-determinism--seeding),
[architecture §3](../../docs/specs/design/controller/02-spec-controller-architecture.md#3-real-time--scheduling-model)).
`scale` multiplies only the wall-clock tick **cadence** (`sleep = tick_period_ms / scale`); it leaves
the per-tick simulation step Δt untouched, so determinism/replay is preserved. Each controller's clock
is **independent** (no shared master); the value is **ephemeral** and resets to the configured default
(1.0) on restart. A real-hardware backend returns **404**, since wall-clock speed is meaningless there;
the platform relays it only as an explicit simulation-only exception (it is not a setpoint). Adding this
surface is **additive**, so `info.version` stays at major 1.

## Identity

The same `greenhouse_id` / `zone_id` lowercase kebab slugs key MQTT topics, REST paths, and DB
rows — one identity, no translation layer
([RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)).
Because a controller process is a single greenhouse, scoping paths under
`/greenhouses/{greenhouse_id}` makes Phase 2's downward setpoint delivery a direct pass-through
of the identity it already holds.

## Units

Carried in field names and descriptions, following the RFC-007 units convention: temperature
°C, humidity %RH, CO₂ ppm, VPD kPa, soil moisture VWC (0–1), DLI mol·m⁻²·day⁻¹. Timestamps are
RFC 3339 / ISO 8601, UTC, millisecond precision.

## Validation semantics

A write is rejected with **422** and a `ValidationError` body that names the violated `field`
and `bound` — the shape Phase 2 relays when it refuses an out-of-bounds setpoint
([RFC-005](../../docs/decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)).
Two classes of rule:

- **Single-field bounds** are expressed in the schema (e.g. `humidity_low_pct` /
  `humidity_high_pct` 0–100 safety bounds, `humidity_deadband_pct` 0–50, `level_pct` 0–100) and
  so are also checked by the fixtures below.
- **Cross-field invariants** that JSON Schema cannot express — `humidity_low_pct` must be below
  `humidity_high_pct` (the humidity safety clamp the VPD-derived RH target is held within),
  `moisture_low_threshold` below `moisture_high_threshold`, and `day_start` before `day_end` —
  are enforced by the controller at runtime and surface as the same 422.

## Authentication

**Unauthenticated by default, with an optional per-controller bearer token.** Out of the box the
controller REST API is unauthenticated — the local Docker network is the trust boundary, not
credentials. For a hardened, multi-host posture the controller config may set `[rest].auth_token`;
when set, the **write** endpoints (setpoint/threshold edits, override management, and the sim-control
writes) require a matching `Authorization: Bearer <token>` and reject unauthenticated writes with
`401`, while **read** endpoints (`/health`, status, zone reads) stay open
([RFC-011](../../docs/decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009),
a config-gated hardening mode that supersedes
[RFC-009](../../docs/decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)
for this surface). The OpenAPI document declares a `bearerAuth` security scheme and lists it as an
**optional** scheme on each write operation (`security: [{}, { bearerAuth: [] }]`) — the empty object
keeps anonymous access valid at the contract level, and whether the token is actually required is
gated on the controller's config. Standalone Phase 1 leaves `auth_token` unset; in managed mode the
platform stores the matching token and presents it on every downward write call.

## Relationship to the MQTT contract

Several shapes are shared with the [MQTT contract](../mqtt/) and are **inlined** here in
`components.schemas` rather than `$ref`'d across folders (cleaner OpenAPI tooling resolution),
with the obligation that they stay in sync:

- The `ActuatorName` enum and the `{ on, level_pct }` `ActuatorOutputState` mirror
  [`actuator-state.schema.json`](../mqtt/actuator-state.schema.json).
- `Health.mode` / `Health.healthy` and the `FaultSummary` shape mirror the `controller` and
  `faults` of [`system-state.schema.json`](../mqtt/system-state.schema.json); `fault_type` /
  `severity` mirror [`fault-event.schema.json`](../mqtt/fault-event.schema.json).
- The `InjectableMetric` enum mirrors the **measured subset** of the
  [`sensor-reading.schema.json`](../mqtt/sensor-reading.schema.json) metric enum — the same
  values minus the derived `vpd`, which is not an injectable channel.

All ultimately trace to the actuator and fault inventories in
[`physical-system-single.md`](../../docs/specs/design/physical-system-single.md) and controller
spec §§5, 7–8. Adding an actuator or fault type is a contract change in both places.

## Examples

[`examples/`](./examples/) holds request/response fixtures used as tests. Positive fixtures must
validate against their component schema; the `*.bad-*.json` counter-examples must **fail**:

- [`setpoints.bad-range.json`](./examples/setpoints.bad-range.json) — `humidity_high_pct` of
  150; rejected by the 0–100 bound.
- [`override.bad-level.json`](./examples/override.bad-level.json) — `level_pct` of 150; rejected
  by the 0–100 bound.
- [`sim-injection.bad-probe.json`](./examples/sim-injection.bad-probe.json) — `probe_index` of
  -1; rejected by the `minimum: 0` bound.
- [`sim-time-scale.bad-range.json`](./examples/sim-time-scale.bad-range.json) — `scale` of 100;
  rejected by the `maximum: 8.0` bound.

| Fixture | Schema | Expect |
|---|---|---|
| `setpoints.json` | `Setpoints` | valid |
| `setpoints.patch.json` | `SetpointsPatch` | valid |
| `setpoints.bad-range.json` | `Setpoints` | **fail** |
| `zone-status.json` | `ZoneStatus` | valid |
| `zone-config.patch.json` | `ZoneConfigPatch` | valid |
| `override.put.json` | `OverridePut` | valid |
| `override.bad-level.json` | `OverridePut` | **fail** |
| `health.json` | `Health` | valid |
| `sim-injection.put.json` | `SensorInjectionPut` | valid |
| `sim-injection.json` | `SensorInjection` | valid |
| `sim-injection.bad-probe.json` | `SensorInjectionPut` | **fail** |
| `sim-time-scale.put.json` | `TimeScalePut` | valid |
| `sim-time-scale.json` | `TimeScale` | valid |
| `sim-time-scale.bad-range.json` | `TimeScalePut` | **fail** |

## Validation

The document and fixtures are checked the same way as the MQTT contract — a 3.1-aware lint of
`openapi.json` (which resolves and validates every `$ref`'d path and component file) plus an Ajv
(Draft 2020-12) run of each fixture against its schema under
[`components/schemas/`](./components/schemas/) (the fixture table above names the schema; the File
layout maps each schema to its file). Each positive fixture must validate and each `*.bad-*.json`
must fail. [`redocly.yaml`](./redocly.yaml) carries the lint config: the
recommended ruleset with three intentional exceptions — `security-defined` is off because the API
is unauthenticated by design (RFC-009, no `securitySchemes`), and `info-license` /
`operation-4xx-response` are off for an internal contract whose `GET /health` has no error path:

```
npx @redocly/cli lint --config contracts/controller-rest/redocly.yaml contracts/controller-rest/openapi.json
```

This check is **automated** by the repo's contract harness —
[`scripts/validate-contracts.mjs`](../../scripts/validate-contracts.mjs) (`npm run validate:contracts`)
lints `openapi.json` with Redocly and validates each fixture against its component schema per
[`examples/cases.json`](./examples/cases.json) — and is fired by the pre-commit contracts gate.
Re-running it in a clean-environment **CI** pipeline is the one piece still deferred
([`docs/backlog.md`](../../docs/backlog.md)); the overall strategy is
[`spec-verification.md`](../../docs/specs/design/spec-verification.md).

## Versioning

`info.version` is the contract version. Additive, backward-compatible changes (a new optional
field, a new endpoint) do **not** bump the major; breaking changes — a removed/renamed field, a
tightened bound, a new required field, a new enum member older clients can't handle — bump the
major, and the previous major is retained side-by-side during transition. Every contract change
is accompanied by an ADR in
[`docs/decisions/`](../../docs/decisions/architecture-design-record.md), per
[RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).
