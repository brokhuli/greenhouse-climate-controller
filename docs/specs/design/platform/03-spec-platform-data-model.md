# Platform — Data Model

> **Purpose:** Define *what state the platform keeps* and why it is split the way it
> is — low-volume relational configuration alongside high-volume time-series
> telemetry, both in one Postgres instance. This is an architectural data model
> (entities and their purpose); concrete schema/DDL is deferred to implementation.
> The profile target bundle deliberately **mirrors** the controller's
> runtime-adjustable config ([controller config](../controller/07-spec-controller-config-and-parameters.md))
> so resolution is a mapping, not a translation.

---

## 1. One instance, two shapes

The platform keeps two kinds of state, in **one Postgres instance** — with the
**TimescaleDB extension** enabled for the time-series tables (it is a Postgres
extension, not a separate database):

**Relational (configuration & metadata)** — low-volume, mutable, strongly related:

| Entity | Purpose |
|---|---|
| Site | The logical grouping of greenhouses run as one operation |
| Greenhouse (registry) | One row per greenhouse: identity, display name, the crop it grows |
| Controller endpoint | How to reach a greenhouse's controller (MQTT topic root, REST base URL), liveness |
| Crop profile | A named, **stage-aware** bundle of climate + irrigation targets for a crop |
| Profile target bundle | The actual values — mirrors the controller's **runtime-adjustable** config: the climate `[setpoints]` (temperature day/night, VPD target + humidity safety bounds, DLI, CO₂) **plus** per-zone soil-moisture thresholds + watering schedule |
| Profile assignment | Which profile (and growth stage) is currently assigned to a greenhouse |
| Intended setpoint state | The effective setpoints the platform believes each greenhouse should be running: resolved profile baseline plus sticky operator edits and accepted optimizer refinements |
| Setpoint revision / provenance | Monotonic revision, source (`profile`, `operator_edit`, `optimizer`), actor/run id, reason, and timestamps for each intended-state change |
| Delivery state | Per-greenhouse status for the latest revision: pending, delivered, acknowledged, rejected, or deferred until reconnect |
| Drift state | The current comparison between intended setpoints and controller-reported setpoints, including first-seen/last-seen timestamps and last correction attempt |
| User / role | Identity and access level (see [security](./07-spec-platform-security.md)) |

**Time-series (telemetry & events)** — high-volume, append-only:

| Stream | Contents |
|---|---|
| Sensor readings | Per-greenhouse fused/raw readings over time (temperature, humidity, CO₂, PAR, per-zone soil moisture) |
| Actuator states | Commanded/observed actuator positions over time |
| Events | Fault events, safety-interlock activations, profile applications, setpoint edits |

On a **simulated** controller the consolidated system-state snapshot also carries the optional
simulation **time-scale** (`time_scale`, `tick_index`,
[controller HAL §7](../controller/03-spec-controller-hal-simulation.md#time-scale-speed-without-breaking-determinism)).
It is **transient telemetry**, not a new relational entity — ingested with the snapshot and surfaced
to the dashboard, never a registry row. Each message's `ts` is the controller's clock instant, so for
an accelerated simulation it is simulated time, stored as published.

---

## 2. Why the split

The split is deliberate: crop profiles, the registry, and assignments are relational
because they are small, edited by hand, and heavily cross-referenced; telemetry is
time-series because it is high-frequency, append-only, and queried by range. Keeping
both in one instance (relational tables + TimescaleDB hypertables) avoids a second
datastore and a second operational surface while letting each table use the access
pattern it needs.

The profile target bundle intentionally **mirrors the controller's runtime-adjustable
config** so that resolving a profile ([crop profiles](./05-spec-platform-crop-profiles.md))
is a direct mapping, not a translation — keeping the contract between platform and
controller thin and the data model honest about where authority lives.

Intended state is stored separately from profiles because it is the platform's live
control ledger, not just crop metadata. A profile assignment contributes the baseline,
an operator setpoint edit can layer a sticky exception on top, and an optimizer plan
can submit a time-bounded refinement. Reconciliation reads the latest intended-state
revision, delivery state records whether that revision reached the controller, and
drift state records whether the controller is still reporting the same effective
setpoints. This is the persistence behind re-assert-on-reconnect, last-write-wins
semantics, provenance, and "operator wins" behavior in Phase 3.

The time-series streams are exactly the surface the controller publishes over MQTT
([controller interfaces](../controller/08-spec-controller-interfaces.md)); the platform
stores what it ingests ([ingestion](./04-spec-platform-ingestion.md)) without reshaping
it. Retention of those streams is owned by
[ingestion](./04-spec-platform-ingestion.md#5-retention--downsampling).

That telemetry retention bounds only the **hypertables**. One relational table is also
append-only: the **setpoint revision / provenance** ledger grows by one row per
intended-state change, so the `drop_chunks` policy does not bound it. It is bounded
instead by a scheduled **prune**: per greenhouse the **latest (current) revision is kept
indefinitely** — it is live intended state that reconciliation reads, never history —
while **superseded** revisions are dropped past a configurable window (default aligned to
the telemetry horizon, **30 days**). Growth is **edit-paced** (operator edits and
optimizer refinements), not sample-paced, so the table is small and the prune is a
guardrail rather than a hot path. It is a plain relational `DELETE`, not a hypertable
policy, run as a TimescaleDB **user-defined action** (`add_job`) so it shares the same
background-job scheduler and job-health metric as retention
([operations §1](./08-spec-platform-operations.md#1-observability)) — no new infrastructure.

---

## 3. Boundary — zone topology is controller-local

The bundle covers only what the controller exposes at *runtime*: climate setpoints and
per-zone irrigation thresholds/schedule. Zone **structure** — adding or removing
[zones](../physical-system-single.md#zones) — is a config-file + restart change on the
controller ([controller config](../controller/07-spec-controller-config-and-parameters.md))
and is **not** in the platform's write path. The platform records a greenhouse's zone
topology as registry metadata it *reads*, never as something it *writes* down to a
controller.

---

## 4. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| How telemetry gets into the time-series store | stores output of | [`04-spec-platform-ingestion.md`](./04-spec-platform-ingestion.md) |
| How profiles resolve into controller setpoints | holds inputs for | [`05-spec-platform-crop-profiles.md`](./05-spec-platform-crop-profiles.md) |
| The runtime-adjustable config the bundle mirrors | mirrors | [controller config](../controller/07-spec-controller-config-and-parameters.md) |
| Users / roles | defines storage for | [`07-spec-platform-security.md`](./07-spec-platform-security.md) |
| Wire shapes of the ingested streams | conforms to | [`contracts/`](../../../../contracts/) |
