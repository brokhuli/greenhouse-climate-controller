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
components/
  schemas/                   # request/response body schemas, one file per resource
    setpoints.json           #   Setpoints, SetpointsPatch
    zones.json               #   ZoneConfig, ZoneConfigPatch, ZoneStatus
    overrides.json           #   Override, OverridePut
    health.json              #   Health, FaultSummary
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

Only the runtime-mutable surfaces accept writes. Adding or removing a zone, and changing HAL
parameters, is a config-file edit plus restart (controller spec
[§4](../../docs/specs/design/spec-climate-controller.md#4-configuration--setpoints)) — there is
deliberately no `POST`/`DELETE` for zones.

## Identity

The same `greenhouse_id` / `zone_id` lowercase kebab slugs key MQTT topics, REST paths, and DB
rows — one identity, no translation layer
([RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)).
Because a controller process is a single greenhouse, scoping paths under
`/greenhouses/{greenhouse_id}` makes Phase 2's downward setpoint delivery a direct pass-through
of the identity it already holds.

## Units

Carried in field names and descriptions, following the RFC-007 units convention: temperature
°C, humidity %RH, CO₂ ppm, VPD kPa, soil moisture %VWC (0–1), DLI mol·m⁻²·day⁻¹. Timestamps are
RFC 3339 / ISO 8601, UTC, millisecond precision.

## Validation semantics

A write is rejected with **422** and a `ValidationError` body that names the violated `field`
and `bound` — the shape Phase 2 relays when it refuses an out-of-bounds setpoint
([RFC-005](../../docs/decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)).
Two classes of rule:

- **Single-field bounds** are expressed in the schema (e.g. `humidity_low_pct` 0–100,
  `level_pct` 0–100) and so are also checked by the fixtures below.
- **Cross-field invariants** that JSON Schema cannot express — `humidity_low_pct` must be below
  `humidity_high_pct`, `moisture_low_threshold` below `moisture_high_threshold` — are enforced by
  the controller at runtime and surface as the same 422.

## Authentication

**None.** The controller REST API is unauthenticated in both standalone and managed mode; it is
reachable only on the trusted local Docker network and protected by network isolation, not
credentials
([RFC-009](../../docs/decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)).
The OpenAPI document therefore declares no `securitySchemes`. If the system ever leaves the
single-host model, this API is the seam to add a per-controller token.

## Relationship to the MQTT contract

Several shapes are shared with the [MQTT contract](../mqtt/) and are **inlined** here in
`components.schemas` rather than `$ref`'d across folders (cleaner OpenAPI tooling resolution),
with the obligation that they stay in sync:

- The `ActuatorName` enum and the `{ on, level_pct }` `ActuatorOutputState` mirror
  [`actuator-state.schema.json`](../mqtt/actuator-state.schema.json).
- `Health.mode` / `Health.healthy` and the `FaultSummary` shape mirror the `controller` and
  `faults` of [`system-state.schema.json`](../mqtt/system-state.schema.json); `fault_type` /
  `severity` mirror [`fault-event.schema.json`](../mqtt/fault-event.schema.json).

All ultimately trace to the actuator and fault inventories in
[`physical-system-single.md`](../../docs/specs/design/physical-system-single.md) and controller
spec §§5, 7–8. Adding an actuator or fault type is a contract change in both places.

## Examples

[`examples/`](./examples/) holds request/response fixtures used as tests. Positive fixtures must
validate against their component schema; the two `*.bad-*.json` counter-examples must **fail**:

- [`setpoints.bad-range.json`](./examples/setpoints.bad-range.json) — `humidity_high_pct` of
  150; rejected by the 0–100 bound.
- [`override.bad-level.json`](./examples/override.bad-level.json) — `level_pct` of 150; rejected
  by the 0–100 bound.

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

This is currently a **manual** check — there is no committed harness or CI yet. Automating it
(extending the `contracts/` validation harness to lint OpenAPI and validate these fixtures) is
tracked in [`docs/backlog.md`](../../docs/backlog.md).

## Versioning

`info.version` is the contract version. Additive, backward-compatible changes (a new optional
field, a new endpoint) do **not** bump the major; breaking changes — a removed/renamed field, a
tightened bound, a new required field, a new enum member older clients can't handle — bump the
major, and the previous major is retained side-by-side during transition. Every contract change
is accompanied by an ADR in
[`docs/decisions/`](../../docs/decisions/architecture-design-record.md), per
[RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).
