# Frontend WebSocket Fan-out Contract

The platform Go API's **live-push surface** — the frames the Phase 2 React SPA receives over a single
WebSocket so the dashboard reflects the fleet in real time without polling. This is **catalog
contract #5** ([`spec-contracts.md §2.5`](../../docs/specs/design/spec-contracts.md)); the normative
artifacts are the JSON Schema files here (Draft 2020-12 — the same dialect as the
[MQTT](../mqtt/), [controller-rest](../controller-rest/), and [frontend-rest](../frontend-rest/)
contracts, per
[RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)).

The SPA's whole contract is with the Go API: **REST** for request/response
([`frontend-rest/`](../frontend-rest/), catalog #4) and **WebSockets** for live push (this contract).
The browser never reaches MQTT or the controllers directly
([frontend overview §3](../../docs/specs/design/frontend/01-spec-frontend-overview.md#3-system-context)).
This contract formalizes the *client's working contract* previously sketched in
[`05-spec-frontend-data-model.md §5`](../../docs/specs/design/frontend/05-spec-frontend-data-model.md#5-websocket-message-taxonomy);
the SPA's Zod schemas in `src/api/schemas.ts` validate against it.

**Scope — server→client push only.** This contract is the four fan-out frames the platform sends. The
SPA subscribes to "the greenhouses currently in view," but that **subscription granularity is
server-decided** ([architecture §4](../../docs/specs/design/frontend/03-spec-frontend-architecture.md#4-runtime-data-flow))
and is **not** a wire contract here — there are no client→server frames. The direction is
Platform → SPA, matching the catalog.

## File layout

Each frame type is its own JSON Schema, composing a shared envelope — the same one-file-per-message
layout as [`mqtt/`](../mqtt/):

```
envelope.schema.json       # the RFC-007 4-field envelope, composed into every frame via allOf
common.schema.json         # shared $defs: connectivity, event_kind, event_severity, metric, unit, reading, actuator_sample, time_scale
message.schema.json        # oneOf union of known frames plus an unknown-type fallback
telemetry.schema.json      # type:"telemetry" — readings[] (+ optional actuators[])
status.schema.json         # type:"status"    — status: connectivity (+ optional time_scale, sim-only)
drift.schema.json          # type:"drift"     — drift: boolean            (2b)
event.schema.json          # type:"event"     — kind / severity / message / source
examples/                  # fixtures used as tests (see below)
```

There is no `redocly.yaml` — that is an OpenAPI artifact (the REST contracts). This contract is
validated with Ajv, exactly like [`mqtt/`](../mqtt/).

## Frame map

One socket; every frame is discriminated by `type`. The effect-on-client column restates
[data model §5](../../docs/specs/design/frontend/05-spec-frontend-data-model.md#5-websocket-message-taxonomy)
(the source of the client behavior); this contract owns the wire shapes.

| `type` | Payload | Effect on client | Slice | Schema |
|---|---|---|---|---|
| `telemetry` | envelope + `readings[]` (+ optional `actuators[]`) | append one point per metric to the per-series ring buffer | 2a | [`telemetry.schema.json`](./telemetry.schema.json) |
| `status` | envelope + `status` (connectivity) (+ optional `time_scale`, sim-only) | patch `greenhouseSummary.status` — and, when present, `greenhouseSummary.time_scale` (the per-greenhouse speed indicator) — in the fleet cache | 2a | [`status.schema.json`](./status.schema.json) |
| `drift` | envelope + `drift` (boolean) | patch `greenhouseSummary.drift`; raise a drift event | 2b | [`drift.schema.json`](./drift.schema.json) |
| `event` | envelope + `kind` / `severity` / `message` / `source` | prepend to the activity feed; raise a toast if `critical` | 2a | [`event.schema.json`](./event.schema.json) |

`message.schema.json` is the consumer entry point: a `oneOf` of the four known frames plus an
unknown-type fallback. A consumer validates each received frame against it, dispatches known `type`
values, and ignores an envelope-valid frame whose `type` it does not understand. Adding a frame type is
therefore additive for older clients.

## Identity

The same `greenhouse_id` / `zone_id` lowercase kebab slugs key MQTT topics, REST paths, DB rows, and
these frames — one identity, no translation layer
([RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)).
Telemetry frames may be zone-scoped (a zone's `soil_moisture` / `par`) and carry the `zone_id`;
`status`, `drift`, and `event` are greenhouse-scoped and pin `zone_id` to `null`.

## Envelope

Every frame carries the four RFC-007 §3 fields ([`envelope.schema.json`](./envelope.schema.json)),
composed via `allOf` — the same envelope the [MQTT](../mqtt/) frames carry, one transport down:

| Field | Type | Notes |
|---|---|---|
| `schema_version` | integer | Major version of the frame schema (see Versioning). |
| `greenhouse_id` | string | The frame's greenhouse, redundant with any subscription so a frame stands alone. |
| `zone_id` | string \| null | Set on zone-scoped telemetry; `null` otherwise. |
| `ts` | string | RFC 3339 / ISO 8601, UTC, millisecond precision. For telemetry, the sample instant. From the controller's injected clock — wall-clock on real hardware / 1×, the simulated instant under an accelerated run, so the SPA plots on simulated time directly. |

`schema_version` is an **integer** per RFC-007, matching the illustrative
`z.number().int()` envelope in
[data model §2](../../docs/specs/design/frontend/05-spec-frontend-data-model.md#2-shared-primitives).
Unlike the REST contracts, frames **do** carry this envelope (like MQTT); the contract version is
`schema_version`, not an `info.version`.

## Frame structure

Each frame is **flat**: the envelope fields, a `type` discriminator, and the payload all sit at the
top level — the same layout as an MQTT message, with `type` added. A frame schema is
`allOf: [ {$ref: envelope}, { …type + payload } ]` closed with `unevaluatedProperties: false`, so no
stray fields slip through. This mirrors `mqtt/` rather than nesting the payload under a `data` wrapper.

The `event` frame is the [frontend-rest `EventEntry`](../frontend-rest/) shape with its `greenhouse_id`
and `ts` lifted into the envelope: REST bodies have no envelope so `EventEntry` embeds them inline,
whereas here they are the envelope's. The dashboard `severity` grading (`info`/`warning`/`critical`)
is distinct from the controller's fault severity (`warning`/`alarm`).

## Units

Carried in `telemetry` readings and bound to the metric, following the RFC-007 units convention and
reusing the MQTT metric→unit binding: temperature °C, humidity %RH, CO₂ ppm, PAR µmol·m⁻²·s⁻¹,
VPD kPa, soil moisture VWC (0–1). A mismatched unit is rejected at the contract boundary (see the
`telemetry.bad-unit.json` fixture). `metric` is a **closed enum** — adding one is a contract change.

## Connection lifecycle

The socket's lifecycle — subscribe-on-view-focus, exponential-backoff reconnect, range-query backfill
after a gap, and the polling fallback — is **owned by the frontend specs**
([architecture §4](../../docs/specs/design/frontend/03-spec-frontend-architecture.md#4-runtime-data-flow),
[interactions §5](../../docs/specs/design/frontend/08-spec-frontend-interactions.md)), not redefined
here (the "reference, don't redefine" convention,
[`spec-conventions.md`](../../docs/specs/design/spec-conventions.md)). The `ConnectionStatus`
indicator is derived from the socket's own open/close state, so there is **no heartbeat frame** in
this contract; the frames here are only the four data-bearing message types above.

## Examples

[`examples/`](./examples/) holds frame fixtures used as tests. Positive fixtures must validate against
their frame schema (and the `message.schema.json` union); the three `*.bad-*.json` counter-examples must
**fail**:

| Fixture | Schema | Expect |
|---|---|---|
| `telemetry.json` | `telemetry.schema.json` | valid |
| `status.json` | `status.schema.json` | valid |
| `drift.json` | `drift.schema.json` | valid |
| `event.json` | `event.schema.json` | valid |
| `telemetry.bad-unit.json` | `telemetry.schema.json` | **fail** (`temperature` with `ppm` — metric→unit binding) |
| `telemetry.bad-extra.json` | `telemetry.schema.json` | **fail** (stray top-level field — envelope+frame `unevaluatedProperties: false` closure) |
| `event.bad-kind.json` | `event.schema.json` | **fail** (`kind` outside the closed enum) |

## Validation

The schemas and fixtures are validated with **Ajv** (Draft 2020-12, strict mode), the same way as the
[MQTT](../mqtt/) contract: each schema is registered by its `$id`, each positive fixture must validate
against its frame schema and the union, and each `*.bad-*.json` must fail. The schemas also compile
clean under strict mode, so strict validators in all three stacks accept them.

Each schema has a stable `$id` under the base `https://greenhouse.local/contracts/frontend-ws/`, and
cross-schema references (the envelope, the shared `$defs` in `common`) use absolute `$id` URIs. The
base is **not a network location** — register the local files under that base with your validator so
refs resolve offline (the same per-stack guidance as [`mqtt/README.md`](../mqtt/README.md#consuming-the-schemas-ref-resolution)).

This check is **automated** by the repo's contract harness —
[`scripts/validate-contracts.mjs`](../../scripts/validate-contracts.mjs) (`npm run validate:contracts`),
fired by the pre-commit contracts gate. Re-running it in a clean-environment **CI** pipeline is the
one piece still deferred ([`docs/backlog.md`](../../docs/backlog.md)); the overall strategy is
[`spec-verification.md`](../../docs/specs/design/spec-verification.md).

## Versioning

`schema_version` is an **integer major**, per RFC-007. Additive, backward-compatible changes (a new
optional field, a **new frame `type`** — clients ignore unknown types) do **not** bump it; breaking
changes — a removed/renamed field, a tightened bound, a new required field, a new enum member older
clients can't handle — bump the major, and the previous major is retained side-by-side during
transition. Every change is accompanied by an ADR in
[`docs/decisions/`](../../docs/decisions/architecture-design-record.md), per
[RFC-007](../../docs/decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format).
