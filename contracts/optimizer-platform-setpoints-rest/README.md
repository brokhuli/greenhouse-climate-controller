# Setpoint API REST Contract (single-authority write path)

The platform Go API's **single-authority setpoint write path** — the request/response contract the
**optimizer** (Phase 3), and later the **Phase 4 planner**, use to submit refined climate targets to
the platform. This is **catalog contract #3**
([`spec-contracts.md §2.3`](../../docs/specs/design/spec-contracts.md)); the normative artifact is
[`openapi.json`](./openapi.json) (OpenAPI 3.1, which uses the JSON Schema 2020-12 dialect — the same
dialect as the [MQTT](../mqtt/), [controller-rest](../controller-rest/), and [frontend-rest](../frontend-rest/)
contracts, per
[RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)).

**This is the platform's single authority for setpoints** ([RFC-005](../../docs/decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)):
the optimizer submits refined targets here; the platform validates them against crop-safe bounds,
records provenance (`source = optimizer`), and delivers them to the controller over the
[controller REST contract](../controller-rest/). MQTT is telemetry-only and is never a setpoint
channel.

**Scope — the optimizer write path only.** The operator's **ad-hoc** setpoint edit
(`PATCH /api/greenhouses/{greenhouse_id}/setpoints`) is the human counterpart and lives in the
separate operator/fleet contract ([`frontend-rest/`](../frontend-rest/), catalog #4). It shares this
contract's `Setpoints` / `SetpointsPatch` body shape but is a **different** operation, audience, and
provenance (`source = operator_edit`, returned `200`). Crop-profile assignment (a third way a bundle
is set, `source = profile`) is also in `frontend-rest`. The live-push WebSocket fan-out is
[`frontend-ws/`](../frontend-ws/) (catalog #5). None of those are described here.

## File layout

[`openapi.json`](./openapi.json) is the entry point and `$ref`s out to the rest:

```
openapi.json                 # info, servers, securitySchemes, and the single-path index
paths/
  setpoints.json             #   /api/greenhouses/{greenhouse_id}/setpoints  (POST)
components/
  schemas/
    setpoints.json           #   Setpoints (target bundle), SetpointsPatch, ZoneTargets
    common.json              #   Slug, Error, ValidationError (shared)
  parameters.json            # shared path parameters (GreenhouseId)
  responses.json             # shared error responses (401, 403, 404, 422, 503)
examples/                    # fixtures used as tests (see below)
redocly.yaml                 # lint config
```

References are relative, the same convention as [`frontend-rest/`](../frontend-rest/) and
[`controller-rest/`](../controller-rest/): the path file points at
`../components/schemas/setpoints.json#/SetpointsPatch`, and schema files cross-reference siblings
(e.g. `setpoints.json` → `./common.json#/Slug`). Any OpenAPI 3.1 tool that follows `$ref`s reads
`openapi.json` directly; `redocly bundle` collapses the tree into one self-contained file. The
`Setpoints` bundle is deliberately a **copy** of the one in `frontend-rest` (same Go DTO backs both
operations), kept local to this contract rather than cross-contract `$ref`'d — the same self-contained
convention the other contracts use for shared definitions.

## Endpoint map

The one greenhouse-scoped path. Base path `/api` is the nginx-proxied prefix.

| Method + path | Purpose | Slice | Success | Errors |
|---|---|---|---|---|
| `POST /api/greenhouses/{greenhouse_id}/setpoints` | Optimizer setpoint submission (single-authority write) | 2b | 202 `Setpoints` | 401, 403, 404, 422, 503 |

The `202 Accepted` body is the resulting **intended state**: the merged bundle recorded with
`source = optimizer` provenance and delivered to the controller, or held and re-asserted when the
controller is offline (platform §5). The operator's ad-hoc `PATCH` on the same path is a **different**
contract (catalog #4, [`frontend-rest/`](../frontend-rest/)).

## Identity

The same `greenhouse_id` lowercase kebab slug keys MQTT topics, controller REST paths, DB rows, and
this API — one identity, no translation layer
([RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)).

## Field naming

Wire field names are **snake_case** (`temperature_day_c`, `greenhouse_id`), consistent with the MQTT,
controller-rest, and frontend-rest contracts and RFC-007. REST bodies are **not** wrapped in the
RFC-007 `schema_version` envelope (matching the other REST contracts); identity (`greenhouse_id`) is
embedded in the path and the contract version is `info.version`.

## Units

Carried in field names and descriptions, following the RFC-007 units convention: temperature °C,
humidity %RH, CO₂ ppm, VPD kPa, soil moisture VWC (0–1), DLI mol·m⁻²·day⁻¹. Timestamps are RFC 3339 /
ISO 8601, UTC, millisecond precision.

## Validation semantics

A submission is rejected with **422** and a `ValidationError` body that names the violated `field` and
`bound` — the same shape the [controller REST](../controller-rest/) and [frontend-rest](../frontend-rest/)
contracts return and the platform relays under
[RFC-005](../../docs/decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain).
A rejected submission is **not** recorded as intended state. Two classes of rule:

- **Single-field bounds** are expressed in the schema (e.g. `humidity_low_pct` / `humidity_high_pct`
  0–100 safety bounds, `humidity_deadband_pct` 0–50, `moisture_low_threshold` 0–1) and are checked by
  the fixtures below.
- **Cross-field invariants** JSON Schema cannot express — `humidity_low_pct` below `humidity_high_pct`,
  `moisture_low_threshold` below `moisture_high_threshold`, `day_start` before `day_end` — are enforced
  server-side and surface as the same 422.
- **Crop-safe envelope** — beyond the generic physical bounds above, a submission on this path is
  additionally validated against the **active crop profile stage's crop-safe envelope** (the per-target
  `min`/`max` an operator sets on the assigned profile, `frontend-rest StageBounds`). A target the plan
  moves outside its envelope is rejected **422** naming that field, with a crop-safe bound. This is the
  platform-side backstop that makes it the single authority for crop safety
  ([RFC-005](../../docs/decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain)):
  the optimizer's own constraint engine pre-filters to the same envelope (read from the
  [planning-context](../optimizer-read-rest/) `bounds`), so a `202` is expected and a `422` means the
  optimizer's view of the bounds disagreed with the platform's — a mid-cycle profile change or contract
  drift, escalated rather than retried. A greenhouse with no assignment, or a stage that defines no
  envelope, is not gated here — only the generic physical bounds apply. The envelope is **not** in the
  request body; it is resolved server-side from the assignment.

A missing greenhouse returns **404**.

## Authentication

**Config-gated service boundary (RFC-011).** This is one of the two internal **write** boundaries
authentication is specified for, shipped as a mode that is **off by default**:

- With **`SERVICE_AUTH_MODE=trusted_network`** (the default), the platform accepts the **untokened**
  internal call — the Docker network is the trust boundary. No `401`/`403` occurs.
- With **`SERVICE_AUTH_MODE=oidc`**, the call requires a Keycloak **client-credentials** access token
  carrying the narrow **`setpoints:write`** service role (an operator token is also accepted); a
  missing/invalid token is **401** and an authenticated token lacking the role is **403**.

The contract is **identical** in both modes — only the `Authorization` header's presence differs — so
`bearerAuth` is declared in `components.securitySchemes` and applied as an **optional** scheme
(`security: [{}, { bearerAuth: [] }]`): the empty object keeps anonymous access valid at the contract
level, and whether the token is actually required is gated on config. When authenticated, the verified
client identity backs the `source = optimizer` provenance. The capability matrix (which role may call
what) is owned by [platform security §4](../../docs/specs/design/platform/07-spec-platform-security.md)
— referenced, not restated.

## Examples

[`examples/`](./examples/) holds request/response fixtures used as tests. Positive fixtures must
validate against their component schema; the `*.bad-*.json` counter-example must **fail**:

| Fixture | Schema | Expect |
|---|---|---|
| `setpoints.patch.json` | `SetpointsPatch` | valid (a partial submission, with zones) |
| `setpoints.json` | `Setpoints` | valid (a full bundle — the 202 response body) |
| `setpoints.bad-range.json` | `Setpoints` | **fail** (`humidity_high_pct` 150, outside 0–100) |

## Validation

The document and fixtures are checked the same way as the other REST contracts — a 3.1-aware lint of
`openapi.json` (which resolves and validates every `$ref`'d path and component file) plus an Ajv
(Draft 2020-12) run of each fixture against its schema under
[`components/schemas/`](./components/schemas/). Each positive fixture must validate and each
`*.bad-*.json` must fail. [`redocly.yaml`](./redocly.yaml) carries the lint config: the recommended
ruleset with one intentional exception — `info-license` is off for an internal contract (repo LICENSE
covers it). `security-defined` and `operation-4xx-response` stay **on**: the POST references the
declared `bearerAuth` scheme and has 4xx error paths.

```
npx @redocly/cli lint --config contracts/optimizer-write-rest/redocly.yaml contracts/optimizer-write-rest/openapi.json
```

This check is **automated** by the repo's contract harness —
[`scripts/validate-contracts.mjs`](../../scripts/validate-contracts.mjs) (`npm run validate:contracts`)
lints `openapi.json` with Redocly and validates each fixture against its component schema per
[`examples/cases.json`](./examples/cases.json) — and is fired by the pre-commit contracts gate.

## Versioning

`info.version` is the contract version. Additive, backward-compatible changes (a new optional field, a
new endpoint) do **not** bump the major; breaking changes — a removed/renamed field, a tightened bound,
a new required field, a new enum member older clients can't handle — bump the major, and the previous
major is retained side-by-side during transition. Every contract change is accompanied by an ADR in
[`docs/decisions/`](../../docs/decisions/architecture-design-record.md), per
[RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).
