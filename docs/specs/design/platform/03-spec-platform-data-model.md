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
| Profile target bundle | The actual values — mirrors the controller's **runtime-adjustable** config: the climate `[setpoints]` (temperature day/night, humidity band, VPD, DLI, CO₂) **plus** per-zone soil-moisture thresholds + watering schedule |
| Profile assignment | Which profile (and growth stage) is currently assigned to a greenhouse |
| User / role | Identity and access level (see [security](./07-spec-platform-security.md)) |

**Time-series (telemetry & events)** — high-volume, append-only:

| Stream | Contents |
|---|---|
| Sensor readings | Per-greenhouse fused/raw readings over time (temperature, humidity, CO₂, PAR, per-zone soil moisture) |
| Actuator states | Commanded/observed actuator positions over time |
| Events | Fault events, safety-interlock activations, profile applications, setpoint edits |

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

The time-series streams are exactly the surface the controller publishes over MQTT
([controller interfaces](../controller/08-spec-controller-interfaces.md)); the platform
stores what it ingests ([ingestion](./04-spec-platform-ingestion.md)) without reshaping
it. Retention and downsampling of those streams are owned by
[ingestion](./04-spec-platform-ingestion.md#5-retention--downsampling).

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
