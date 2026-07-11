# Platform Read API REST Contract (Phase 3 optimizer planning-context read path)

The platform Go API's **Phase 3 telemetry read path** — the request/response contract the
**optimizer** (Phase 3) uses to read one greenhouse's planning context from the platform's history.
This is **catalog contract #7**
([`spec-contracts.md §2.7`](../../docs/specs/design/spec-contracts.md)); the normative artifact is
[`openapi.json`](./openapi.json) (OpenAPI 3.1, which uses the JSON Schema 2020-12 dialect — the same
dialect as the [MQTT](../mqtt/), [controller-rest](../controller-rest/), [frontend-rest](../frontend-rest/),
and [optimizer-write-rest](../optimizer-write-rest/) contracts, per
[RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)).

This is the optimizer's **read** counterpart to its setpoint **write** path
([`optimizer-write-rest/`](../optimizer-write-rest/), catalog #3). Per the **revised**
[RFC-008](../../docs/decisions/request-for-comments.md#rfc-008-phase-3-telemetry-read-path)
([ADR 2026-07-07](../../docs/decisions/architecture-design-record.md)), the cross-service boundary is
**REST**: the platform may back these handlers with **internal SQL views or TimescaleDB continuous
aggregates**, but those database objects are platform-internal implementation details — not the
contract — and the optimizer never connects to the database directly. The earlier RFC-008 design
(direct read-only DB access via a versioned view surface) was replaced to keep Phase 3 consistent
with the rest of the system's contract posture: cross-component boundaries are REST / WebSocket /
MQTT / JSON-schema, not shared database access.

## Scope — the optimizer read path only

One endpoint returns everything the optimizer's **Data Access** component needs for one planning
cycle, in a single bounded read: **current setpoints**, **bucketed telemetry summaries**, **latest
actuator states**, and the **data-quality / freshness signals** its
[input gate](../../docs/specs/design/optimizer/07-spec-optimizer-input-gating.md) runs before
planning. History is returned as `(min, mean, max)` **summaries** per metric per bucket
([RFC-004](../../docs/decisions/request-for-comments.md#rfc-004-phase-3-llm-integration-interface)),
not raw readings, so the payload stays bounded.

This is **distinct** from the operator/fleet telemetry range query
(`GET .../telemetry?window`, [`frontend-rest/`](../frontend-rest/), catalog #4): that seeds the SPA's
charts with raw readings; this serves the optimizer's planning context as summaries plus provenance
and data-quality signals. The **setpoint write path** (`POST .../setpoints`) is
[`optimizer-write-rest/`](../optimizer-write-rest/) (catalog #3); the live-push WebSocket fan-out is
[`frontend-ws/`](../frontend-ws/) (catalog #5). None of those are described here.

## File layout

[`openapi.json`](./openapi.json) is the entry point and `$ref`s out to the rest:

```
openapi.json                 # info, servers, and the single-path index (no securitySchemes — unauthenticated)
paths/
  planning-context.json      #   /api/greenhouses/{greenhouse_id}/planning-context  (GET)
components/
  schemas/
    planning-context.json    #   PlanningContext + CurrentSetpoints, Setpoints, ZoneTargets,
                             #   MetricSummarySeries, SummaryBucket, ActuatorSnapshot, DataQuality,
                             #   MetricFreshness, SensorFault, ActuatorHealth, ControllerMode
    common.json              #   Slug, Error, ValidationError, Metric, ActuatorName (shared)
  parameters.json            # shared parameters (GreenhouseId, Window, Interval)
  responses.json             # shared error responses (404, 422)
examples/                    # fixtures used as tests (see below)
redocly.yaml                 # lint config
```

References are relative, the same convention as [`optimizer-write-rest/`](../optimizer-write-rest/) and
[`frontend-rest/`](../frontend-rest/). Any OpenAPI 3.1 tool that follows `$ref`s reads `openapi.json`
directly; `redocly bundle` collapses the tree into one self-contained file. The `Setpoints` /
`ZoneTargets` bundle, the `Metric` enum, and the `ActuatorName` enum are deliberately **copies** of
the definitions in `optimizer-write-rest` / `frontend-rest` (the same Go DTOs back them), kept local to this
contract rather than cross-contract `$ref`'d — the same self-contained convention the other contracts
use for shared definitions.

## Endpoint map

The one greenhouse-scoped path. Base path `/api` is the nginx-proxied prefix.

| Method + path | Purpose | Slice | Success | Errors |
|---|---|---|---|---|
| `GET /api/greenhouses/{greenhouse_id}/planning-context?window=&interval=` | Optimizer planning-context read (setpoints + telemetry summaries + actuator states + data quality) | 3 | 200 `PlanningContext` | 404, 422 |

`window` is a trailing history window (`6h`, `12h`, `24h`, `48h`; default `12h` — the optimizer's
planning horizon), resolved server-side against the greenhouse's latest stored (simulated) timestamp;
the response `from`/`to` report the resolved span. `interval` is the summary bucket width (`1h`, `6h`,
`1d`; default `1h` — the hourly summary of RFC-004). An unknown `window`/`interval` is rejected 422.

## The response

`PlanningContext` is one bounded object:

- **`greenhouse_id`** — echoed so the optimizer's identity-consistency check confirms it received the
  greenhouse it queried for.
- **`schema_version`** — the response schema major version; see [schema_version](#schema_version-in-body) below.
- **`from` / `to` / `interval`** — the resolved window span and bucket width; ages in `data_quality`
  are computed against `to`.
- **`setpoints`** — `CurrentSetpoints`: the current intended state (`targets`, the same bundle
  `optimizer-write-rest` accepts/returns) with its `source` (`optimizer` / `operator_edit` / `profile`) and
  `updated_at` provenance — the crop-safe baseline the optimizer refines against. It also carries the
  active stage's crop-safe **`bounds`** (`StageBounds`, an optional `min`/`max` per scalar climate
  target, plus an optional per-zone irrigation envelope under `bounds.zones`, `ZoneBounds`): the
  envelope the optimizer's constraint engine refines within and the platform enforces on the write
  path, so a plan that clears the engine is expected to be accepted (a `422` signals the envelope
  disagreed). `bounds` is absent when the stage defines none.
- **`telemetry`** — one `MetricSummarySeries` per metric/scope pair, each a list of `SummaryBucket`
  `(bucket_start, min, mean, max, count)`. Per-zone soil moisture stays distinct (its own `zone_id`).
- **`actuators`** — the latest `ActuatorSnapshot` per actuator/scope: `commanded`, `observed`
  (0–100, on/off devices use 0/100), and `health` (`ok` / `stuck` / `no_response`).
- **`data_quality`** — the input-gate signals: `controller_mode`, `time_scale` (sim-only clock mode;
  `null` on real hardware), `freshness[]` (per-metric `latest_ts` / `age_seconds` / `sample_count`),
  and `faults[]` (active per-sensor faults).

The `data_quality` block and per-actuator `health` resolve the RFC-008 open question the input-gating
spec flagged (*"which fields the API carries… to resolve when the REST contract is authored"*): the
gate's four checks map to fields here — **freshness/completeness** → `freshness[]`, **sensor health** →
`faults[]`, **actuator health** → `ActuatorSnapshot.health`, **clock mode** → `time_scale` (with
`controller_mode` for the controller-degraded case). When a check fails the optimizer holds the cycle
and extends the last accepted plan rather than planning over untrusted inputs.

## Identity

The same `greenhouse_id` lowercase kebab slug keys MQTT topics, controller REST paths, DB rows, and
this API — one identity, no translation layer
([RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)).
Zone-scoped rows (soil-moisture series, per-zone actuators, per-zone faults) carry a non-null
`zone_id`; greenhouse-scoped rows carry `null`. The optimizer's identity-consistency check rejects a
`zone_id` polarity violation or an off-greenhouse row as contract drift.

### schema_version in-body

REST bodies in the platform's **write** contracts (`optimizer-write-rest`, `frontend-rest`) are **not**
wrapped in the RFC-007 `schema_version` envelope — their identity is the path `greenhouse_id` and
their version is `info.version`. This **read** contract is the one exception: it carries a top-level
`schema_version` integer, because the optimizer's identity-consistency check explicitly reads it to
detect read-API/contract **drift** (*"an unknown `schema_version` means the read API or a contract has
drifted"*, [input-gating spec](../../docs/specs/design/optimizer/07-spec-optimizer-input-gating.md)).
`schema_version` tracks `info.version`'s major and bumps with it on a breaking change.

## Field naming

Wire field names are **snake_case** (`greenhouse_id`, `bucket_start`, `age_seconds`), consistent with
the MQTT, controller-rest, frontend-rest, and optimizer-write-rest contracts and RFC-007.

## Units

Carried in field names and descriptions, following the RFC-007 units convention: temperature °C,
humidity %RH, CO₂ ppm, PAR µmol·m⁻²·s⁻¹, VPD kPa, soil moisture VWC (0–1), DLI mol·m⁻²·day⁻¹; actuator
positions 0–100. Timestamps are RFC 3339 / ISO 8601, UTC, millisecond precision.

## Validation semantics

A bad **query parameter** (an unknown `window` or `interval`) is rejected **422** with a
`ValidationError` body naming the violated `field` and `bound` — the same shape the other REST
contracts return. A missing greenhouse returns **404**. The read has no request body and no
cross-field write invariants; there is no 422 for body validation.

## Authentication

**Unauthenticated on the trusted Docker network.** This is a **read** path: it carries no authority
and no safety concern (it cannot drive the greenhouse to an unsafe state), so it matches the
anonymous-viewer posture of the operator/fleet telemetry reads (`frontend-rest` slice 2a).
[RFC-011](../../docs/decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009)
scopes config-gated service auth to the two **write** boundaries (controller REST, setpoint POST), not
this read. The single operation declares `security: []` (explicitly public) and the document defines
no `securitySchemes`; accordingly `redocly.yaml` turns `security-defined` off (documented there).

## Examples

[`examples/`](./examples/) holds response fixtures used as tests. Positive fixtures must validate
against their component schema; the `*.bad-*.json` counter-example must **fail**:

| Fixture | Schema | Expect |
|---|---|---|
| `planning-context.json` | `PlanningContext` | valid (a full read: house + zone series, an `ok` and a `no_response` actuator, freshness + a sensor fault) |
| `summary-series.json` | `MetricSummarySeries` | valid (a bucketed metric series, including a `count: 0` gap bucket) |
| `planning-context.bad-range.json` | `PlanningContext` | **fail** (an actuator `observed` of 150, outside 0–100) |

## Validation

The document and fixtures are checked the same way as the other REST contracts — a 3.1-aware lint of
`openapi.json` (which resolves and validates every `$ref`'d path and component file) plus an Ajv
(Draft 2020-12) run of each fixture against its schema under
[`components/schemas/`](./components/schemas/). Each positive fixture must validate and each
`*.bad-*.json` must fail. [`redocly.yaml`](./redocly.yaml) carries the lint config: the recommended
ruleset with two intentional exceptions — `info-license` off for an internal contract (repo LICENSE
covers it) and `security-defined` off because the contract is entirely unauthenticated (no scheme to
check). `operation-4xx-response` stays **on**: the GET has 404/422 error paths.

```
npx @redocly/cli lint --config contracts/optimizer-read-rest/redocly.yaml contracts/optimizer-read-rest/openapi.json
```

This check is **automated** by the repo's contract harness —
[`scripts/validate-contracts.mjs`](../../scripts/validate-contracts.mjs) (`npm run validate:contracts`)
lints `openapi.json` with Redocly and validates each fixture against its component schema per
[`examples/cases.json`](./examples/cases.json) — and is fired by the pre-commit contracts gate.

## Versioning

`info.version` is the contract version. Additive, backward-compatible changes (a new optional field, a
new endpoint) do **not** bump the major; breaking changes — a removed/renamed field, a tightened
bound, a new required field, a new enum member older clients can't handle — bump the major, and the
previous major is retained side-by-side during transition. The in-body `schema_version` tracks the
`info.version` major. Every contract change is accompanied by an ADR in
[`docs/decisions/`](../../docs/decisions/architecture-design-record.md), per
[RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).
