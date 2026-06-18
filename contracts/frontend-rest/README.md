# Frontend (Operator/Fleet) REST Contract

The platform Go API's **operator-facing REST surface** — the request/response half of the contract
the Phase 2 React SPA (and operator tooling) consumes, and the Go API (Echo) serves. This is
**catalog contract #4** ([`spec-contracts.md §2.4`](../../docs/specs/design/spec-contracts.md));
the normative artifact is [`openapi.json`](./openapi.json) (OpenAPI 3.1, which uses the JSON Schema
2020-12 dialect — the same dialect as the [MQTT](../mqtt/) and [controller-rest](../controller-rest/)
contracts, per
[RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)).

The SPA's whole contract is with the Go API: **REST** for request/response (this document) and
**WebSockets** for live push. The browser never reaches MQTT or the controllers directly
([frontend overview §3](../../docs/specs/design/frontend/01-spec-frontend-overview.md#3-system-context)).
This contract formalizes the REST half of the *client's working contract* previously sketched in
[`05-spec-frontend-data-model.md`](../../docs/specs/design/frontend/05-spec-frontend-data-model.md);
the SPA's Zod schemas in `src/api/schemas.ts` validate against it.

**Scope — REST only.** The live-push WebSocket fan-out (telemetry, status, drift, events) is a
**separate** contract ([`frontend-ws/`](../frontend-ws/), catalog #5) and is **not** described here.

## File layout

[`openapi.json`](./openapi.json) is the entry point and `$ref`s out to the rest:

```
openapi.json                 # info, servers, securitySchemes, and the paths index (one $ref per path)
paths/                       # one file per path
  greenhouses.json           #   /api/greenhouses                            (GET, POST)
  greenhouse-by-id.json      #   /api/greenhouses/{greenhouse_id}            (GET, DELETE)
  setpoints.json             #   /api/greenhouses/{greenhouse_id}/setpoints  (PATCH)
  telemetry.json             #   /api/greenhouses/{greenhouse_id}/telemetry  (GET)
  analytics.json             #   /api/greenhouses/{greenhouse_id}/analytics  (GET)
  assignment.json            #   /api/greenhouses/{greenhouse_id}/assignment (GET, PUT)   (2b)
  events.json                #   /api/events                                 (GET)
  profiles.json              #   /api/profiles                               (GET, POST)  (2b)
  profile-by-id.json         #   /api/profiles/{profile_id}                  (GET, PATCH, DELETE) (2b)
components/
  schemas/                   # request/response body schemas, one file per resource
    common.json              #   Slug, Connectivity, ActuatorName, Error, ValidationError (shared)
    greenhouses.json         #   GreenhouseSummary, GreenhouseDetail, GreenhouseRegistration, ControllerEndpoint
    setpoints.json           #   Setpoints (target bundle), SetpointsPatch, ZoneTargets
    telemetry.json           #   TelemetryRange, TelemetrySeries, Reading, ActuatorState
    analytics.json           #   AnalyticsResponse, AnalyticsSeries, AnalyticsBucket
    events.json              #   EventEntry
    profiles.json            #   CropProfile, CropProfilePatch, ProfileStage, Assignment, AssignmentInput (2b)
  parameters.json            # shared path/query parameters
  responses.json             # shared error responses (401, 403, 404, 422)
examples/                    # fixtures used as tests (see below)
redocly.yaml                 # lint config
```

References are relative, the same convention as [`controller-rest/`](../controller-rest/): a path
file points at `../components/schemas/greenhouses.json#/GreenhouseSummary`, and schema files
cross-reference siblings (e.g. `greenhouses.json` → `./common.json#/Slug`, `profiles.json` →
`./setpoints.json#/Setpoints`). Any OpenAPI 3.1 tool that follows `$ref`s reads `openapi.json`
directly; `redocly bundle` collapses the tree into one self-contained file.

## Endpoint map

Greenhouse-scoped paths use `greenhouse_id`; profile paths use `profile_id`. Base path `/api` is the
nginx-proxied prefix.

| Method + path | Purpose | Slice | Success | Errors |
|---|---|---|---|---|
| `GET /api/greenhouses` | Fleet list | 2a | 200 `GreenhouseSummary[]` | — |
| `POST /api/greenhouses` | Register a greenhouse | 2a | 201 `GreenhouseSummary` | 422 |
| `GET /api/greenhouses/{greenhouse_id}` | Detail snapshot incl. current setpoints | 2a | 200 `GreenhouseDetail` | 404 |
| `DELETE /api/greenhouses/{greenhouse_id}` | Retire a greenhouse | 2a | 204 | 404 |
| `PATCH /api/greenhouses/{greenhouse_id}/setpoints` | Ad-hoc setpoint edit | 2a | 200 `Setpoints` | 404, 422 |
| `GET /api/greenhouses/{greenhouse_id}/telemetry?from&to` | Historical range query | 2a | 200 `TelemetryRange` | 404, 422 |
| `GET /api/greenhouses/{greenhouse_id}/analytics?from&to&metric&interval` | Aggregated/derived series | 2a | 200 `AnalyticsResponse` | 404, 422 |
| `GET /api/events?greenhouse_id&kind&severity` | Activity feed | 2a | 200 `EventEntry[]` | — |
| `GET /api/profiles` | Crop-profile library | 2b | 200 `CropProfile[]` | 401 |
| `POST /api/profiles` | Create a profile | 2b | 201 `CropProfile` | 401, 403, 422 |
| `GET /api/profiles/{profile_id}` | One profile | 2b | 200 `CropProfile` | 401, 404 |
| `PATCH /api/profiles/{profile_id}` | Edit a profile | 2b | 200 `CropProfile` | 401, 403, 404, 422 |
| `DELETE /api/profiles/{profile_id}` | Delete a profile | 2b | 204 | 401, 403, 404, 422 |
| `GET /api/greenhouses/{greenhouse_id}/assignment` | Current assignment | 2b | 200 `Assignment` | 401, 404 |
| `PUT /api/greenhouses/{greenhouse_id}/assignment` | Assign profile/stage | 2b | 200 `Assignment` | 401, 403, 404, 422 |

The optimizer's single-authority `POST /greenhouses/{id}/setpoints` (RFC-005 write path) is a
**different** contract (catalog #3) and is not here; the ad-hoc edit above is the operator's path.

## Delivery slices

Every operation carries an `x-slice` extension (`2a` or `2b`), matching the spec set's `(2a)`/`(2b)`
convention ([ADR 2026-06-11](../../docs/decisions/architecture-design-record.md)). **2a** is the
monitoring + setpoint-edit MVP (fleet, detail, telemetry, events, registration, edits); **2b** adds
crop-profile authority and assignments. The split is a property of the surface, not two documents —
one contract carries both.

## Identity

The same `greenhouse_id` / `zone_id` lowercase kebab slugs key MQTT topics, controller REST paths,
DB rows, and this API — one identity, no translation layer
([RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)).
`profile_id` is a slug in the same scheme.

## Field naming

Wire field names are **snake_case** (`temperature_day_c`, `greenhouse_id`, `display_name`),
consistent with the MQTT and controller-rest contracts and RFC-007. The SPA's TypeScript/Zod types
([data model §2](../../docs/specs/design/frontend/05-spec-frontend-data-model.md)) are camelCase and
map onto these — the data-model doc's snippets are explicitly *illustrative, not final field names*.
Unlike the MQTT/WS frames, REST resources do **not** wrap bodies in the RFC-007 `schema_version`
envelope (matching the controller-rest contract); identity (`greenhouse_id`) is embedded directly
where a body is greenhouse-scoped, and the contract version is `info.version`.

## Units

Carried in field names and descriptions, following the RFC-007 units convention: temperature °C,
humidity %RH, CO₂ ppm, VPD kPa, soil moisture VWC (0–1), DLI mol·m⁻²·day⁻¹. Timestamps are
RFC 3339 / ISO 8601, UTC, millisecond precision.

## Validation semantics

A write is rejected with **422** and a `ValidationError` body that names the violated `field` and
`bound` — the same shape the [controller REST contract](../controller-rest/) returns and the
platform relays under [RFC-005](../../docs/decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain).
Two classes of rule:

- **Single-field bounds** are expressed in the schema (e.g. `humidity_low_pct` 0–100,
  `moisture_low_threshold` 0–1) and are checked by the fixtures below.
- **Cross-field invariants** JSON Schema cannot express — `humidity_low_pct` below
  `humidity_high_pct`, `moisture_low_threshold` below `moisture_high_threshold`, `day_start` before
  `day_end`, a telemetry `from` at or before `to`, an assignment `stage` that exists in the profile,
  a profile still referenced by an assignment — are enforced server-side and surface as the same 422.

A missing greenhouse, profile, or assignment returns **404**.

## Authentication

**Slice-dependent.** In **2a** the API is **unauthenticated** on the trusted local Docker network
([RFC-009](../../docs/decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries));
2a operations declare `security: []`. In **2b** the operations require a Keycloak OIDC bearer token
(`bearerAuth`, declared in `components.securitySchemes`): the Go API validates the token (signature,
issuer, audience, expiry) and maps its roles onto the platform's **viewer** (read) and **operator**
(read + write) roles. A missing/invalid token is **401**; an authenticated non-operator attempting a
write is **403**. The capability matrix (which role may call what) is owned by
[platform security §4](../../docs/specs/design/platform/07-spec-platform-security.md) — referenced,
not restated. This differs from the controller-rest contract, which is unauthenticated in every mode.

## Examples

[`examples/`](./examples/) holds request/response fixtures used as tests. Positive fixtures must
validate against their component schema; the two `*.bad-*.json` counter-examples must **fail**:

| Fixture | Schema | Expect |
|---|---|---|
| `greenhouse-summary.json` | `GreenhouseSummary` | valid |
| `greenhouse-detail.json` | `GreenhouseDetail` | valid |
| `registration.json` | `GreenhouseRegistration` | valid |
| `setpoints.patch.json` | `SetpointsPatch` | valid |
| `setpoints.bad-range.json` | `Setpoints` | **fail** (`humidity_high_pct` 150, outside 0–100) |
| `telemetry-range.json` | `TelemetryRange` | valid |
| `analytics.json` | `AnalyticsResponse` | valid |
| `event.json` | `EventEntry` | valid |
| `event.bad-kind.json` | `EventEntry` | **fail** (`kind` outside the closed enum) |
| `profile.json` | `CropProfile` | valid |
| `assignment.json` | `Assignment` | valid |

## Validation

The document and fixtures are checked the same way as the MQTT and controller-rest contracts — a
3.1-aware lint of `openapi.json` (which resolves and validates every `$ref`'d path and component
file) plus an Ajv (Draft 2020-12) run of each fixture against its schema under
[`components/schemas/`](./components/schemas/). Each positive fixture must validate and each
`*.bad-*.json` must fail. [`redocly.yaml`](./redocly.yaml) carries the lint config: the recommended
ruleset with two intentional exceptions — `info-license` is off for an internal contract (repo
LICENSE covers it), and `operation-4xx-response` is off because the fleet list and activity feed are
collection reads with no 4XX path. `security-defined` stays **on**: 2b operations reference the
declared `bearerAuth` scheme and 2a operations declare `security: []`.

```
npx @redocly/cli lint --config contracts/frontend-rest/redocly.yaml contracts/frontend-rest/openapi.json
```

This is currently a **manual** check — there is no committed harness or CI yet. Automating it
(extending the `contracts/` validation harness to lint OpenAPI and validate these fixtures) is the
same item tracked in [`docs/backlog.md`](../../docs/backlog.md).

## Versioning

`info.version` is the contract version. Additive, backward-compatible changes (a new optional field,
a new endpoint) do **not** bump the major; breaking changes — a removed/renamed field, a tightened
bound, a new required field, a new enum member older clients can't handle — bump the major, and the
previous major is retained side-by-side during transition. Every contract change is accompanied by an
ADR in [`docs/decisions/`](../../docs/decisions/architecture-design-record.md), per
[RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).
