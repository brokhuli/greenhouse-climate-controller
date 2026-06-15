# Frontend — Data Model & API Binding

> **Purpose:** Define the shapes the SPA consumes and how they bind to the
> backend. This is the dashboard's analogue of a content schema — except the SPA
> **authors no content**; every shape originates from the Go API
> ([platform §7](../spec-climate-platform.md#7-api-surface)) over REST and
> WebSockets. This file defines the client-side TypeScript/Zod types, the
> query-key scheme, the cache + live-merge strategy, runtime validation, the
> WebSocket message taxonomy, and the view-model derivations the UI renders.

> **Source of truth & a documented gap.** The wire contracts are owned by
> [`contracts/`](../../../../contracts/) under the conventions in
> [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format),
> and the API *surface* by [platform §7](../spec-climate-platform.md#7-api-surface).
> Today `contracts/` formalizes only `mqtt/` (telemetry, platform-internal) and
> `controller-rest/` (platform→controller). **The Go-API ↔ SPA REST/WS contract is
> not yet formalized in `contracts/`.** Until it is, the schemas here bind to
> platform §7 and are the *client's working contract*; when the API contract is
> formalized, these Zod schemas must be regenerated/validated against it, and this
> file points at it. The shapes below mirror the platform's
> [data model (§3)](../spec-climate-platform.md#3-data-model) so the mapping stays
> thin.

> All schema snippets are **illustrative** — they show intent and field origin, not
> final field names. The Zod schema in `src/api/schemas.ts` is the implementation
> source of truth; this doc explains *why* each shape exists and *how* it maps to a
> view.

---

## 1. Where data comes from

| Channel | Used for | Cached in |
|---|---|---|
| **REST GET** | Snapshots + historical range queries (fleet, greenhouse, telemetry, profiles, events) | TanStack Query cache |
| **REST PATCH/POST** | Writes (setpoint edits 2a; profile assign/apply 2b) | invalidates / patches Query cache |
| **WebSocket** | Live push: telemetry, status changes, drift, events | per-series ring buffer + Query-cache patches |

The split mirrors [architecture §4](./spec-frontend-architecture.md#4-runtime-data-flow):
REST seeds and backfills; WS carries the live edge.

---

## 2. Shared primitives

Defined once in `src/api/schemas.ts` and reused (illustrative):

```ts
import { z } from "zod";

// Identity per RFC-007 (greenhouse_id / zone_id).
export const greenhouseId = z.string().min(1);
export const zoneId = z.string().min(1);

// RFC-007 payload envelope (every message carries these).
export const envelope = z.object({
  greenhouse_id: greenhouseId,
  ts: z.coerce.date(),          // server timestamp
  schema_version: z.string(),   // payload schema version (RFC-007)
});

export const connectivity = z.enum(["online", "degraded", "offline"]);
export const reading = z.object({ value: z.number(), ts: z.coerce.date() });
```

Identity, the envelope, and versioning follow
[RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)
— the client validates `schema_version` and degrades on mismatch
([§7](#7-runtime-validation)).

---

## 3. Relational shapes (config & metadata)

Mirror the platform's relational model
([§3](../spec-climate-platform.md#3-data-model)). Low-volume, fetched by REST.

### Fleet & greenhouse (2a)

```ts
export const greenhouseSummary = z.object({
  id: greenhouseId,
  displayName: z.string(),
  crop: z.string().nullable(),           // assigned crop (label only in 2a)
  status: connectivity,
  drift: z.boolean().default(false),     // (2b) intended ≠ reported setpoints
  // compact current-vs-target readout for the fleet card
  climate: z.object({
    temperature: z.number().nullable(),
    setpointTemperature: z.number().nullable(),
  }).partial(),
});

export const fleet = z.array(greenhouseSummary);
```

### Setpoints / target bundle

Mirrors the controller's runtime-adjustable
[`[setpoints]`](../spec-climate-platform.md#3-data-model) plus per-zone irrigation,
so a profile resolves by direct mapping:

```ts
export const setpoints = z.object({
  temperatureDay: z.number(),
  temperatureNight: z.number(),
  humidityMin: z.number(),
  humidityMax: z.number(),
  vpd: z.number().optional(),
  dli: z.number().optional(),
  co2: z.number().optional(),
  zones: z.array(z.object({
    zoneId,
    soilMoistureMin: z.number(),
    soilMoistureMax: z.number(),
    // watering schedule mirrors the controller's runtime config
    schedule: z.array(z.object({ start: z.string(), durationMin: z.number() })),
  })),
});
```

### Crop profiles & assignment (2b)

```ts
export const cropProfile = z.object({
  id: z.string(),
  name: z.string(),
  crop: z.string(),
  stages: z.array(z.object({
    stage: z.string(),          // propagation / vegetative / fruiting / …
    targets: setpoints,         // the stage-aware target bundle
  })),
});

export const assignment = z.object({
  greenhouseId,
  profileId: z.string(),
  stage: z.string(),
});
```

> **Boundary.** The bundle covers only what the controller exposes at *runtime*
> (climate setpoints + per-zone irrigation). **Zone *topology*** — adding/removing
> zones — is a controller config + restart change and is **not** in the platform's
> write path, so the SPA never edits it
> ([platform §3 boundary](../spec-climate-platform.md#3-data-model)).

---

## 4. Time-series shapes (telemetry & events)

High-volume, append-only. Fetched as range queries and streamed live.

```ts
// A range query result for one greenhouse over [from, to].
export const telemetryRange = z.object({
  greenhouse_id: greenhouseId,
  series: z.record(z.string(), z.array(reading)), // metric -> samples
});

export const actuatorState = z.object({
  actuator: z.string(),
  commanded: z.number(),
  observed: z.number().nullable(),
  ts: z.coerce.date(),
});

export const eventEntry = z.object({
  greenhouse_id: greenhouseId,
  ts: z.coerce.date(),
  kind: z.enum(["fault", "interlock", "profile_applied", "setpoint_edit", "drift"]),
  severity: z.enum(["info", "warning", "critical"]),
  message: z.string(),
  source: z.string().optional(),  // who/what (audit, platform §6)
});
```

Metrics covered (matching the controller's published surface,
[P1 §11](../controller/spec-controller-interfaces.md)): temperature, humidity, CO₂,
PAR, per-zone soil moisture, actuator positions.

---

## 5. WebSocket message taxonomy

One socket; frames are discriminated by `type`. Each is Zod-parsed before use.

| `type` | Payload | Effect on client |
|---|---|---|
| `telemetry` | envelope + metric readings | append to the per-series ring buffer for that greenhouse |
| `status` | envelope + `connectivity` | patch `greenhouseSummary.status` in the fleet cache |
| `drift` *(2b)* | envelope + `{ drift: boolean }` | patch `greenhouseSummary.drift`; raise a drift event |
| `event` | `eventEntry` | prepend to the activity feed cache; raise a toast if critical |

```ts
export const wsMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("telemetry"), data: /* envelope + readings */ z.any() }),
  z.object({ type: z.literal("status"),    data: z.object({ greenhouse_id: greenhouseId, status: connectivity }) }),
  z.object({ type: z.literal("drift"),     data: z.object({ greenhouse_id: greenhouseId, drift: z.boolean() }) }),
  z.object({ type: z.literal("event"),     data: eventEntry }),
]);
```

`ws.ts` parses each frame, then routes telemetry to the ring buffer and the rest to
Query-cache patches ([architecture §4](./spec-frontend-architecture.md#4-runtime-data-flow)).
Unknown `type` values are ignored (forward-compatible).

---

## 6. Query keys & cache strategy

Stable, hierarchical keys so WS patches and mutations target the right cache
entries:

| Key | Source | Notes |
|---|---|---|
| `["fleet"]` | `GET /api/greenhouses` | patched by `status` / `drift` frames |
| `["greenhouse", id]` | `GET /api/greenhouses/:id` | snapshot incl. current setpoints |
| `["telemetry", id, range]` | `GET /api/greenhouses/:id/telemetry?from&to` | historical half of the chart |
| `["events", scope]` | `GET /api/events?…` | activity feed; prepended by `event` frames |
| `["profiles"]` / `["profile", id]` *(2b)* | `GET /api/profiles…` | profile library + editor |

Strategy:

- **`staleTime`** tuned per key (fleet short; profiles longer) so background
  refetch stays cheap.
- **Live patches beat refetch.** A `status`/`drift`/`event` frame updates the cache
  in place rather than refetching, keeping fan-out within `P2-PERF-2` (< 1 s).
- **Mutations** (setpoint edit, profile assign) optimistically patch then settle on
  the server response; on error they roll back ([interactions](./spec-frontend-interactions.md)).
- **Backfill** after a WS gap re-runs the affected `["telemetry", id, range]` query
  ([architecture §4](./spec-frontend-architecture.md#4-runtime-data-flow)).

---

## 7. Runtime validation

Every REST response and WS frame is parsed through its Zod schema in
`src/api/`. The policy:

- **Dev:** a parse failure **throws** — a contract drift is a bug, surfaced loudly.
- **Prod:** a parse failure **drops the offending record**, logs it, and renders
  the rest. A single malformed telemetry sample never blanks a chart (the
  degrade-don't-crash rule, [architecture §9](./spec-frontend-architecture.md#9-failure-modes--recovery)).
- **`schema_version` mismatch** (RFC-007) is logged and surfaced as a non-blocking
  "data format changed — update the dashboard" notice.

This is the client's enforcement point for the API contract until that contract is
formalized in `contracts/` (see the scope note above).

---

## 8. View-model derivations

Pure functions in `src/lib/` turn raw API data into what the UI shows. They are
unit-tested and never embedded in components:

| Derivation | Inputs | Used by |
|---|---|---|
| **Reading-vs-setpoint delta** | current reading + setpoint | detail metric tiles, fleet card |
| **Status rollup** | per-greenhouse `status` + `drift` | fleet site-wide summary (e.g. "3 online, 1 degraded, 1 drift") |
| **Series merge** | history range + live ring buffer | the continuous detail chart (de-dup at the seam) |
| **Event severity grouping** | event stream | activity feed ordering + toast triggering |
| **In-band / out-of-band band** | reading vs humidity/temperature band | chart threshold shading (chart tokens) |

Keeping these pure means a view never recomputes climate logic inline, and the
derivations are testable in isolation (`P2-TEST-2`-adjacent unit coverage).

---

## 9. Cross-references

- API surface (routes + responsibilities): [platform §7](../spec-climate-platform.md#7-api-surface)
- Wire conventions (envelope, identity, versioning): [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)
- Platform data model the shapes mirror: [platform §3](../spec-climate-platform.md#3-data-model)
- How the cache is fed and patched: [architecture §4](./spec-frontend-architecture.md#4-runtime-data-flow)
- Forms reusing these schemas: [tech-stack — forms](./spec-frontend-tech-stack.md)
- Contracts catalog (index of all contracts): [`spec-contracts.md`](../spec-contracts.md)
