# Frontend — Data Model & API Binding

> **Purpose:** Define the shapes the SPA consumes and how they bind to the
> backend. This is the dashboard's analogue of a content schema — except the SPA
> **authors no content**; every shape originates from the Go API
> ([platform API surface](../platform/09-spec-platform-interfaces.md#3-api-surface-inventory)) over REST and
> WebSockets. This file defines the client-side TypeScript/Zod types, the
> query-key scheme, the cache + live-merge strategy, runtime validation, the
> WebSocket message taxonomy, and the view-model derivations the UI renders.

> **Source of truth.** The wire contracts are owned by
> [`contracts/`](../../../../contracts/) under the conventions in
> [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format),
> and the API *surface* by [platform API surface](../platform/09-spec-platform-interfaces.md#3-api-surface-inventory).
> `contracts/` formalizes `mqtt/` (telemetry, platform-internal),
> `controller-rest/` (platform-to-controller), `frontend-rest/` (Go API to SPA REST),
> and `frontend-ws/` (Go API to SPA live push). The snippets here are the client's
> working model and explanatory mirror of those formal contracts; the implementation
> Zod schemas must validate against the formal contracts. The shapes below mirror the platform's
> [data model](../platform/03-spec-platform-data-model.md) so the mapping stays thin.

> All schema snippets are **illustrative** — they show intent and field origin, not
> final field names. The Zod schemas in `src/api/schemas.ts` are the implementation
> source of truth (themselves validated against [`contracts/`](../../../../contracts/), per
> the source-of-truth note above); this doc explains *why* each shape exists and
> *how* it maps to a view.

> **Two layers — wire vs view-model.** The `Wire*Schema` Zod parsers in
> `src/api/schemas.ts` validate the **snake_case** wire shapes exactly as authored in
> [`contracts/`](../../../../contracts/) — same field names, requiredness, and bounds.
> Thin **adapter** functions in `src/api/` then map a parsed wire object into the
> **camelCase** view-model (VM) type the components consume; the pure
> [view-model derivations](#8-view-model-derivations) in `src/lib/` operate on those VMs.
> Snippets below are tagged *(wire)* or *(view-model)* — the casing flip at the adapter
> is intentional, **not** a contract discrepancy. Components and the rest of these specs
> reference the camelCase VM (e.g. `greenhouseSummary.timeScale`).

---

## 1. Where data comes from

| Channel | Used for | Cached in |
|---|---|---|
| **REST GET** | Snapshots + historical range queries (fleet, greenhouse, telemetry, profiles, events) | TanStack Query cache |
| **REST PATCH/POST** | Writes (setpoint edits 2a; profile assign/apply 2b) | invalidates / patches Query cache |
| **WebSocket** | Live push: telemetry, status changes, drift, events | per-series ring buffer + Query-cache patches |

The split mirrors [architecture §4](./03-spec-frontend-architecture.md#4-runtime-data-flow):
REST seeds and backfills; WS carries the live edge.

---

## 2. Shared primitives

Defined once in `src/api/schemas.ts` and reused *(wire — snake_case, per RFC-007)*:

```ts
import { z } from "zod";

// Identity per RFC-007 (greenhouse_id / zone_id).
export const greenhouseId = z.string().min(1);
export const zoneId = z.string().min(1);

// RFC-007 payload envelope (every message carries these).
export const envelope = z.object({
  greenhouse_id: greenhouseId,
  ts: z.coerce.date(),          // controller clock instant (simulated time for simulated runs)
  schema_version: z.number().int(), // payload schema major version (RFC-007)
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
([data model](../platform/03-spec-platform-data-model.md)). Low-volume, fetched by REST.

### Fleet & greenhouse (2a)

*(wire)* — mirrors [`GreenhouseSummary`](../../../../contracts/frontend-rest/components/schemas/greenhouses.json):

```ts
export const wireGreenhouseSummary = z.object({
  id: greenhouseId,
  display_name: z.string(),
  crop: z.string().nullable(),                      // assigned crop (label only in 2a)
  status: connectivity,
  drift: z.boolean().default(false),               // (2b) intended ≠ reported setpoints
  time_scale: z.number().nullable().optional(),    // sim-only: simulated-clock speed (1 = real-time); null/absent on real hardware
  // compact current-vs-target readout for the fleet card
  climate: z.object({
    temperature: z.number().nullable(),
    setpoint_temperature: z.number().nullable(),
  }).partial().optional(),
});

export const wireFleet = z.array(wireGreenhouseSummary);
```

*(view-model)* — the adapter flips casing into the shape components render; this is the
single representative example, the same pattern applies to every wire schema below:

```ts
export type GreenhouseSummary = {
  id: string; displayName: string; crop: string | null;
  status: Connectivity; drift: boolean; timeScale: number | null;
  climate: { temperature?: number | null; setpointTemperature?: number | null };
};

export const toGreenhouseSummary =
  (w: z.infer<typeof wireGreenhouseSummary>): GreenhouseSummary => ({
    id: w.id, displayName: w.display_name, crop: w.crop,
    status: w.status, drift: w.drift, timeScale: w.time_scale ?? null,
    climate: {
      temperature: w.climate?.temperature,
      setpointTemperature: w.climate?.setpoint_temperature,
    },
  });
```

### Greenhouse registration (2a)

The body an operator POSTs to register a greenhouse into the fleet *(wire)* — mirrors
[`GreenhouseRegistration`](../../../../contracts/frontend-rest/components/schemas/greenhouses.json):

```ts
export const wireGreenhouseRegistration = z.object({
  id: greenhouseId,                    // operator-chosen slug, reused across MQTT/REST/DB (RFC-007)
  display_name: z.string().min(1),
  crop: z.string().nullable().optional(),
  controller: z.object({               // registry metadata the platform needs to reach the controller
    rest_base_url: z.string().url(),   // e.g. http://gh-a:8080 (local Docker network)
    mqtt_topic_root: z.string(),       // e.g. gh/gh-a
  }),
});
```

> **Registration metadata, not zone topology.** The controller endpoint is
> *registration-time* config the platform needs to reach the controller — the SPA never
> speaks it directly. This is distinct from the zone-*topology* boundary below: the SPA
> registers/retires greenhouses but never edits their zones.

### Setpoints / target bundle

*(wire)* — mirrors the contract's
[`Setpoints`](../../../../contracts/frontend-rest/components/schemas/setpoints.json) field
for field, which in turn mirrors the controller's runtime-adjustable
[`[setpoints]`](../platform/03-spec-platform-data-model.md) plus per-zone irrigation, so a
profile resolves by direct mapping. Every field is required (the contract's `Setpoints`
is a complete bundle; partial edits use `SetpointsPatch` — see [§6 mutations](#6-query-keys--cache-strategy)):

```ts
export const wireSetpoints = z.object({
  temperature_day_c: z.number(),
  temperature_night_c: z.number(),
  day_start: z.string(),                          // day-window start, HH:MM (24h)
  day_end: z.string(),                            // day-window end, HH:MM; must be after day_start (else 422)
  humidity_low_pct: z.number(),                   // lower RH safety bound; the VPD-derived target clamps to [low, high]
  humidity_high_pct: z.number(),                  // upper RH safety bound
  humidity_deadband_pct: z.number(),              // hysteresis band width around the RH target
  co2_target_ppm: z.number().int(),               // enrichment target
  co2_vent_interlock_threshold_pct: z.number(),   // vent-open % above which CO₂ injection is interlocked off
  vpd_target_kpa: z.number(),                     // primary humidity input; RH target derived by inverting VPD
  dli_target_mol: z.number(),                     // daily light integral target driving supplemental lighting
  zones: z.array(z.object({
    zone_id: zoneId,
    moisture_low_threshold: z.number(),           // VWC 0–1; irrigate below
    moisture_high_threshold: z.number(),          // VWC 0–1; stop above
    drain_period_secs: z.number().int(),          // min gap between cycles (anti-saturation)
    schedule: z.string(),                         // comma-separated HH:MM triggers, e.g. "06:00,14:00"
  })),
});
```

### Crop profiles & assignment (2b)

*(wire)* — mirror [`CropProfile`](../../../../contracts/frontend-rest/components/schemas/profiles.json#L15)
and [`Assignment`](../../../../contracts/frontend-rest/components/schemas/profiles.json#L49):

```ts
export const wireCropProfile = z.object({
  id: z.string(),
  name: z.string(),
  crop: z.string(),
  stages: z.array(z.object({
    stage: z.string(),            // propagation / vegetative / fruiting / …
    targets: wireSetpoints,       // the stage-aware target bundle
  })).min(1),
});

export const wireAssignment = z.object({
  greenhouse_id: greenhouseId,
  profile_id: z.string(),
  stage: z.string(),
});
```

> **Boundary.** The bundle covers only what the controller exposes at *runtime*
> (climate setpoints + per-zone irrigation). **Zone *topology*** — adding/removing
> zones — is a controller config + restart change and is **not** in the platform's
> write path, so the SPA never edits it
> ([platform data model boundary](../platform/03-spec-platform-data-model.md)).

---

## 4. Time-series shapes (telemetry & events)

High-volume, append-only. Fetched as range queries and streamed live *(wire)*.

```ts
// A range query result for one greenhouse over [from, to] — raw samples.
export const telemetryRange = z.object({
  greenhouse_id: greenhouseId,
  series: z.array(z.object({
    metric: z.enum(["temperature", "humidity", "co2", "par", "vpd", "soil_moisture"]),
    zone_id: zoneId.nullable(),
    readings: z.array(reading),
  })), // one entry per metric/scope pair
});

// Aggregated counterpart for long ranges — time-bucketed min/max/avg per metric/scope.
// Mirrors contracts/frontend-rest AnalyticsResponse; the chart switches to this past a
// range threshold (architecture §4 "Historical + live merge").
export const analyticsResponse = z.object({
  greenhouse_id: greenhouseId,
  from: z.coerce.date(),
  to: z.coerce.date(),
  interval: z.enum(["5m", "15m", "1h", "6h", "1d"]),
  series: z.array(z.object({
    metric: z.enum(["temperature", "humidity", "co2", "par", "vpd", "soil_moisture"]),
    zone_id: zoneId.nullable(),
    buckets: z.array(z.object({
      bucket_start: z.coerce.date(),
      min: z.number(), max: z.number(), avg: z.number(),
      count: z.number().int(),
    })),
  })), // one entry per metric/scope pair
});

export const actuatorState = z.object({
  actuator: z.string(),
  zone_id: zoneId.nullable(),
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
[P1 §11](../controller/08-spec-controller-interfaces.md)): temperature, humidity, CO₂,
PAR, per-zone soil moisture, actuator positions.

> **`ts` is simulated time.** Each reading's `ts` comes from the controller's injected clock, so on a
> simulated greenhouse it is the *simulated* instant, advancing at that controller's
> [time-scale](../controller/03-spec-controller-hal-simulation.md#time-scale-speed-without-breaking-determinism)
> (wall-clock on real hardware / 1×). Charts therefore plot directly against `ts` and need no speed
> correction; the current speed is carried separately as `greenhouseSummary.timeScale` (above) for the
> speed indicator.

---

## 5. WebSocket message taxonomy

One socket; frames are discriminated by `type`. Each is Zod-parsed before use.

| `type` | Payload | Effect on client |
|---|---|---|
| `telemetry` | envelope + metric readings | append to the per-series ring buffer for that greenhouse |
| `status` | envelope + `connectivity` (+ optional `time_scale`, sim-only) | patch `greenhouseSummary.status` — and, when present, `greenhouseSummary.timeScale` — in the fleet cache |
| `drift` *(2b)* | envelope + `{ drift: boolean }` | patch `greenhouseSummary.drift`; raise a drift event |
| `event` | `eventEntry` | prepend to the activity feed cache; raise a toast if critical |

Each frame is **flat** — the RFC-007 envelope, the `type` discriminator, and the
payload all sit at the top level (the same layout as an MQTT message, no `data`
wrapper). The Zod union mirrors that wire shape directly:

```ts
// Envelope fields carried by every frame (RFC-007), spread into each member.
const wsEnvelope = {
  schema_version: z.number().int(),
  greenhouse_id: greenhouseId,
  zone_id: zoneId.nullable(),
  ts: z.coerce.date(),
};

export const wsMessage = z.discriminatedUnion("type", [
  z.object({ ...wsEnvelope, type: z.literal("telemetry"),
             readings: z.array(z.object({ metric: z.string(), value: z.number(), unit: z.string() })),
             actuators: z.array(actuatorState).optional() }),
  z.object({ ...wsEnvelope, type: z.literal("status"),
             status: connectivity, time_scale: z.number().optional() }),  // time_scale: sim-only
  z.object({ ...wsEnvelope, type: z.literal("drift"),  drift: z.boolean() }),  // (2b)
  z.object({ ...wsEnvelope, type: z.literal("event"),
             kind: eventEntry.shape.kind, severity: eventEntry.shape.severity,
             message: z.string(), source: z.string().optional() }),
]);
```

`ws.ts` parses each frame against this union, then routes telemetry to the ring
buffer and the rest to Query-cache patches
([architecture §4](./03-spec-frontend-architecture.md#4-runtime-data-flow)).
Unknown `type` values are ignored (forward-compatible).

> The final wire shapes are owned by the WebSocket contract (catalog #5,
> [`contracts/frontend-ws/`](../../../../contracts/frontend-ws/)); the union above mirrors
> it field-for-field. The `event` frame's `greenhouse_id`/`ts` come from the envelope (the
> REST `eventEntry` embeds them inline because REST bodies carry no envelope). Any per-channel
> shape `ws.ts` derives *after* parsing is an **internal adapter type**, not the wire.

---

## 6. Query keys & cache strategy

Stable, hierarchical keys so WS patches and mutations target the right cache
entries:

| Key | Source | Notes |
|---|---|---|
| `["fleet"]` | `GET /api/greenhouses` | patched by `status` / `drift` frames |
| `["greenhouse", id]` | `GET /api/greenhouses/:id` | snapshot incl. current setpoints |
| `["telemetry", id, range]` | `GET /api/greenhouses/:id/telemetry?from&to` | historical half of the chart (raw samples, short ranges) |
| `["analytics", id, range, interval]` | `GET /api/greenhouses/:id/analytics?from&to&interval` | aggregated long-range chart series (replaces raw telemetry past the range threshold — [architecture §4](./03-spec-frontend-architecture.md#4-runtime-data-flow)) |
| `["events", scope]` | `GET /api/events?…` | activity feed; prepended by `event` frames |
| `["profiles"]` / `["profile", id]` *(2b)* | `GET /api/profiles…` | profile library + editor |

Strategy:

- **`staleTime`** tuned per key (fleet short; profiles longer) so background
  refetch stays cheap.
- **Live patches beat refetch.** A `status`/`drift`/`event` frame updates the cache
  in place rather than refetching, keeping fan-out within `P2-PERF-2` (< 1 s).
- **Mutations** (setpoint edit, profile assign, greenhouse register/retire)
  optimistically patch then settle on the server response; on error they roll back
  ([interactions](./08-spec-frontend-interactions.md)). **Register**
  (`POST /api/greenhouses`) and **retire** (`DELETE /api/greenhouses/:id`) both
  invalidate `["fleet"]`; retire also drops `["greenhouse", id]`.
- **Backfill** after a WS gap re-runs the affected `["telemetry", id, range]` query
  ([architecture §4](./03-spec-frontend-architecture.md#4-runtime-data-flow)).

---

## 7. Runtime validation

Every REST response and WS frame is parsed through its Zod schema in
`src/api/`. The policy:

- **Dev:** a parse failure **throws** — a contract drift is a bug, surfaced loudly.
- **Prod:** a parse failure **drops the offending record**, logs it, and renders
  the rest. A single malformed telemetry sample never blanks a chart (the
  degrade-don't-crash rule, [architecture §9](./03-spec-frontend-architecture.md#9-failure-modes--recovery)).
- **`schema_version` mismatch** (RFC-007) is logged and surfaced as a non-blocking
  "data format changed — update the dashboard" notice.

This is the client's runtime enforcement point. The Go-API-to-SPA REST and WebSocket contracts
are authored under [`contracts/`](../../../../contracts/) (`frontend-rest/`, `frontend-ws/`), so
these Zod schemas validate against them rather than standing as a parallel source of truth.

---

## 8. View-model derivations

Pure functions in `src/lib/` turn raw API data into what the UI shows. They are
unit-tested and never embedded in components:

| Derivation | Inputs | Used by |
|---|---|---|
| **Reading-vs-setpoint delta** | current reading + setpoint | detail metric tiles, fleet card |
| **Status rollup** | per-greenhouse `status` + `drift` | fleet site-wide summary (e.g. "3 online, 1 degraded, 1 drift") |
| **Range-tier selection** | requested range vs threshold | picks raw `telemetry` vs `analytics` aggregates and the bucket `interval` (architecture §4) |
| **Series merge** | history range (raw **or** analytics buckets) + live ring buffer | the continuous detail chart (de-dup on `ts` at the seam) |
| **Event severity grouping** | event stream | activity feed ordering + toast triggering |
| **In-band / out-of-band band** | reading vs humidity/temperature band | chart threshold shading (chart tokens) |
| **Simulated-time axis** | series `ts` + `timeScale` | the detail chart's x-axis (plots on simulated time) + the speed indicator label |

Keeping these pure means a view never recomputes climate logic inline, and the
derivations are testable in isolation (`P2-TEST-2`-adjacent unit coverage).

---

## 9. Cross-references

- API surface (routes + responsibilities): [platform API surface](../platform/09-spec-platform-interfaces.md#3-api-surface-inventory)
- REST wire contract: see [`spec-contracts.md`](../spec-contracts.md#24-phase-2-operatorfleet-rest-api)
- WS wire contract: see [`spec-contracts.md`](../spec-contracts.md#25-phase-2-websocket-fan-out)
- Wire conventions (envelope, identity, versioning): [RFC-007](../../../decisions/request-for-comments.md#rfc-007-contract-conventions-mqtt-topics-identity-payload-envelope-schema-format)
- Platform data model the shapes mirror: [platform data model](../platform/03-spec-platform-data-model.md)
- How the cache is fed and patched: [architecture §4](./03-spec-frontend-architecture.md#4-runtime-data-flow)
- Forms reusing these schemas: [tech-stack — forms](./04-spec-frontend-tech-stack.md)
- Contracts catalog (index of all contracts): [`spec-contracts.md`](../spec-contracts.md)
