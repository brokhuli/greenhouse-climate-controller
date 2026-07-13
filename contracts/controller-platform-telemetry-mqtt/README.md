# MQTT Contracts

The topic map and message schemas the Phase 1 controller publishes, the Phase 2 platform
ingests, and the Phase 3 optimizer reads through history. These are the **single source of
truth** for the MQTT wire format across all three stacks (Rust, Go, Python).

**MQTT is telemetry-only.** The controller *publishes*; it subscribes to nothing. Setpoints
reach the controller over REST with Phase 2 as the single authority — there are no
command/plan topics here
([RFC-005](../../docs/decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain),
[RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)).

## Topic map

| Topic | Message | Schema | QoS | Retained |
|---|---|---|---|---|
| `gh/{greenhouse_id}/sensor/{metric}` | greenhouse-scoped sensor reading | [`sensor-reading.schema.json`](./sensor-reading.schema.json) | 1 | no |
| `gh/{greenhouse_id}/zone/{zone_id}/sensor/{metric}` | zone-scoped sensor reading | [`sensor-reading.schema.json`](./sensor-reading.schema.json) | 1 | no |
| `gh/{greenhouse_id}/actuator/{actuator}/state` | house-level actuator state | [`actuator-state.schema.json`](./actuator-state.schema.json) | 1 | no |
| `gh/{greenhouse_id}/fault` | fault event | [`fault-event.schema.json`](./fault-event.schema.json) | 1 | no |
| `gh/{greenhouse_id}/state` | consolidated system state | [`system-state.schema.json`](./system-state.schema.json) | 1 | **yes** |

- Hierarchical so an ingester can wildcard-subscribe per greenhouse (`gh/+/#`) or per metric.
- **QoS 1** on all telemetry (at-least-once).
- **Retained on `gh/{id}/state` only** — a subscriber has current state on connect. Per-sensor
  topics are not retained; the consolidated state is the single retained snapshot
  ([RFC-007 open-question resolution](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)).
  When a greenhouse is **retired**, the platform clears this retained snapshot with a
  zero-length retained publish so it is not replayed to new subscribers — the end of the
  retained message's lifecycle (platform-side broker housekeeping, not a controller command).
- A sensor reading uses the **same schema** whether greenhouse- or zone-scoped; scope is
  carried by the topic and the envelope `zone_id`, not by the metric.
- The simulated-clock **time-scale** rides inside the retained `gh/{id}/state` snapshot as an
  optional `simulation` object (`time_scale`, `tick_index`) — sim-only, omitted on real hardware.
  No new topic: it is part of the consolidated state, set over the controller's sim-only
  [`/sim/time-scale`](../controller-rest/) REST surface (controller HAL §7).
- The `actuator/{actuator}/state` topic carries **house-level** actuators only. `irrigation_valve`
  is per-zone and is **not** published here — there is no zone-scoped actuator topic; per-zone valve
  state is reported only in the retained `gh/{id}/state` snapshot's `zones[].irrigation`. (The
  `irrigation_valve` enum member is retained because the same actuator set is used for manual
  overrides and the system-state snapshot.)

## Identity

| Field | Rule |
|---|---|
| `greenhouse_id` | Stable lowercase kebab slug, unique site-wide (e.g. `gh-a`, `lettuce-north`). |
| `zone_id` | Lowercase kebab slug, unique within a greenhouse (e.g. `bench-a`). `null` on greenhouse-scoped messages. |

The same `greenhouse_id` / `zone_id` are the keys in MQTT topics, REST paths, and DB rows —
one identity, no translation layer.

## Envelope

Every message carries these four fields ([`envelope.schema.json`](./envelope.schema.json)),
composed into each message schema via `allOf`:

| Field | Type | Notes |
|---|---|---|
| `schema_version` | integer | Major version of the message schema (see Versioning). |
| `greenhouse_id` | string | Redundant with topic; lets ingested rows stand alone. |
| `zone_id` | string \| null | Present for zone-scoped messages; `null` otherwise. |
| `ts` | string | RFC 3339 / ISO 8601, UTC, millisecond precision (e.g. `2026-06-07T14:03:00.000Z`). Taken from the controller's injected clock — wall-clock on real hardware / 1×, the simulated instant under an accelerated run (controller HAL §7), so telemetry plots on simulated time directly. |

## Units

Carried explicitly in sensor payloads; each metric is **bound to its unit** in the schema:

| Metric | Unit |
|---|---|
| `temperature` | °C |
| `humidity` | %RH |
| `co2` | ppm |
| `par` | µmol·m⁻²·s⁻¹ |
| `vpd` | kPa |
| `soil_moisture` | VWC (0–1 fraction) |

`metric` and `actuator` names are **closed enums** — adding one is a contract change (see
Versioning).

The **Daily Light Integral** (`dli`, `mol·m⁻²·d⁻¹`) is a *derived* control value — the light
accumulated so far for the current crop day — not a per-tick sensor metric. It is carried only in
the consolidated [`system-state`](./system-state.schema.json) snapshot (always present), so there
is no `gh/{id}/sensor/dli` topic; the underlying light it integrates is the `par` reading.

## Examples

[`examples/`](./examples/) holds fixtures used as tests. Positive fixtures must validate
against their schema; the three `*.bad-*.json` counter-examples must **fail**:

- [`sensor-reading.bad-unit.json`](./examples/sensor-reading.bad-unit.json) — `temperature`
  with `ppm`; rejected by the metric→unit binding.
- [`actuator-state.bad-level.json`](./examples/actuator-state.bad-level.json) — `level_pct`
  of 150; rejected by the 0–100 bound.
- [`sensor-reading.bad-extra.json`](./examples/sensor-reading.bad-extra.json) — an otherwise
  valid reading with a stray top-level `bogus_field`; rejected by the envelope+message
  `unevaluatedProperties: false` closure.

## Validation

The schemas and the `examples/` fixtures are validated with **Ajv** (Draft 2020-12, strict
mode): each positive fixture must validate against its schema, and each `*.bad-*.json`
counter-example must fail. The schemas also compile clean under strict mode, so the strict
validators in all three stacks accept them.

This check is **automated** by the repo's contract harness —
[`scripts/validate-contracts.mjs`](../../scripts/validate-contracts.mjs) (`npm run validate:contracts`),
fired by the pre-commit contracts gate. Re-running it in a clean-environment **CI** pipeline is the
one piece still deferred ([`docs/backlog.md`](../../docs/backlog.md)); the overall strategy is
[`spec-verification.md`](../../docs/specs/design/spec-verification.md).

## Consuming the schemas (`$ref` resolution)

Each schema has a stable `$id` under the base
`https://greenhouse.local/contracts/mqtt/`, and cross-schema references use absolute `$id`
URIs (the envelope, and the shared `$defs` reused by `system-state`). The `$id` base is **not
a network location** — register the local files under that base URI with your validator so
refs resolve offline:

- **Rust** ([`jsonschema`](https://crates.io/crates/jsonschema)) — compile with a resolver /
  document store mapping each `$id` to the local file.
- **Go** ([`santhosh-tekuri/jsonschema`](https://github.com/santhosh-tekuri/jsonschema)) —
  `Compiler.AddResource(id, file)` for each schema, then `Compile(id)`.
- **Python** ([`jsonschema`](https://pypi.org/project/jsonschema/)) — build a `referencing`
  `Registry` from the local files keyed by `$id`.

## Versioning

`schema_version` is an **integer major**. Additive, backward-compatible changes (a new
optional field) do **not** bump it. Breaking changes — a removed/renamed field, a tightened
type, a new enum member that older consumers can't handle — bump the major; the previous
major's schema is retained side-by-side during transition. Every contract change is
accompanied by an ADR in [`docs/decisions/`](../../docs/decisions/architecture-design-record.md),
per [RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).
