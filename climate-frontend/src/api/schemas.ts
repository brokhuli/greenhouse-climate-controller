import { z } from "zod";

/**
 * Runtime schemas for the Go-API ↔ SPA contract.
 *
 * Two layers, per data-model spec §"two layers":
 *  - `Wire*` Zod schemas validate the **snake_case** wire shapes exactly as authored in
 *    `contracts/frontend-rest/` and `contracts/frontend-ws/` (field names, requiredness, bounds).
 *  - `to*` adapter functions map a parsed wire object into the **camelCase** view-model the
 *    components consume. The casing flip at the adapter is intentional, not a contract drift.
 *
 * The contracts are the source of truth; these schemas mirror them and are checked against the
 * committed contract fixtures in the test suite.
 */

// ---------------------------------------------------------------------------
// Shared primitives (RFC-007 identity, envelope, enums)
// ---------------------------------------------------------------------------

/** Lowercase kebab slug — the one identity used across MQTT, REST, DB, and these frames. */
const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "expected a lowercase kebab slug");

/** RFC 3339 / ISO 8601 timestamp string (kept as a string on the wire; adapters produce Date). */
const isoTimestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "expected an ISO 8601 timestamp");

/** HH:MM 24-hour time-of-day. */
const timeOfDay = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "expected HH:MM (24h)");

/** Comma-separated HH:MM irrigation triggers, e.g. "06:00,14:00". */
const schedule = z
  .string()
  .regex(
    /^([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9])*$/,
    "expected HH:MM[,HH:MM…]",
  );

export const connectivitySchema = z.enum(["online", "degraded", "offline"]);
export const metricSchema = z.enum([
  "temperature",
  "humidity",
  "co2",
  "par",
  "vpd",
  "soil_moisture",
]);
export const eventKindSchema = z.enum([
  "fault",
  "interlock",
  "profile_applied",
  "setpoint_edit",
  "drift",
]);
export const eventSeveritySchema = z.enum(["info", "warning", "critical"]);
export const analyticsIntervalSchema = z.enum(["5m", "15m", "1h", "6h", "1d"]);
export const actuatorNameSchema = z.enum([
  "heater",
  "fans",
  "roof_vents",
  "misters",
  "co2_injector",
  "grow_lights",
  "shade_screen",
  "irrigation_valve",
]);
export const unitSchema = z.enum(["°C", "%RH", "ppm", "µmol·m⁻²·s⁻¹", "kPa", "VWC"]);

export type Connectivity = z.infer<typeof connectivitySchema>;
export type Metric = z.infer<typeof metricSchema>;
export type EventKind = z.infer<typeof eventKindSchema>;
export type EventSeverity = z.infer<typeof eventSeveritySchema>;
export type AnalyticsInterval = z.infer<typeof analyticsIntervalSchema>;
export type ActuatorName = z.infer<typeof actuatorNameSchema>;
export type Unit = z.infer<typeof unitSchema>;

/** The metric→unit binding the telemetry contract enforces (frontend-ws common.schema.json). */
export const METRIC_UNIT: Record<Metric, Unit> = {
  temperature: "°C",
  humidity: "%RH",
  co2: "ppm",
  par: "µmol·m⁻²·s⁻¹",
  vpd: "kPa",
  soil_moisture: "VWC",
};

// ---------------------------------------------------------------------------
// REST wire schemas (contracts/frontend-rest)
// ---------------------------------------------------------------------------

export const wireZoneTargets = z.object({
  zone_id: slug,
  moisture_low_threshold: z.number().min(0).max(1),
  moisture_high_threshold: z.number().min(0).max(1),
  drain_period_secs: z.number().int().min(0),
  schedule,
});

/** Live per-zone irrigation state served on the detail snapshot (frontend-rest ZoneStatus). */
export const wireZoneStatus = z.object({
  zone_id: slug,
  soil_moisture_vwc: z.number().min(0).max(1).nullable(),
  irrigating: z.boolean(),
  faulted: z.boolean(),
  last_cycle_ts: isoTimestamp.nullable(),
});

export const wireSetpoints = z.object({
  temperature_day_c: z.number().min(-20).max(60),
  temperature_night_c: z.number().min(-20).max(60),
  day_start: timeOfDay,
  day_end: timeOfDay,
  humidity_low_pct: z.number().min(0).max(100),
  humidity_high_pct: z.number().min(0).max(100),
  humidity_deadband_pct: z.number().min(0).max(50),
  co2_target_ppm: z.number().int().min(0).max(5000),
  co2_vent_interlock_threshold_pct: z.number().min(0).max(100),
  vpd_target_kpa: z.number().min(0),
  dli_target_mol: z.number().min(0),
  zones: z.array(wireZoneTargets),
});

export const wireSetpointsPatch = wireSetpoints
  .partial()
  .refine(
    (patch) => Object.keys(patch).length >= 1,
    "a setpoints patch must change at least one field",
  );

const wireClimate = z
  .object({
    temperature: z.number().nullable(),
    humidity: z.number().nullable(),
    co2: z.number().nullable(),
    dli: z.number().nullable(),
  })
  .partial();

export const wireGreenhouseSummary = z.object({
  id: slug,
  display_name: z.string(),
  crop: z.string().nullable(),
  status: connectivitySchema,
  drift: z.boolean().default(false),
  time_scale: z.number().min(0.25).max(8).nullable().optional(),
  climate: wireClimate.optional(),
});

export const wireGreenhouseDetail = z.object({
  id: slug,
  display_name: z.string(),
  crop: z.string().nullable(),
  status: connectivitySchema,
  drift: z.boolean().default(false),
  time_scale: z.number().min(0.25).max(8).nullable().optional(),
  setpoints: wireSetpoints,
  zone_status: z.array(wireZoneStatus),
});

export const wireGreenhouseRegistration = z.object({
  id: slug,
  display_name: z.string().min(1),
  crop: z.string().nullable().optional(),
  controller: z.object({
    rest_base_url: z.string().url(),
    mqtt_topic_root: z.string(),
  }),
});

export const wireReading = z.object({ value: z.number(), ts: isoTimestamp });

export const wireTelemetrySeries = z.object({
  metric: metricSchema,
  zone_id: slug.nullable(),
  readings: z.array(wireReading),
});

export const wireActuatorState = z.object({
  actuator: actuatorNameSchema,
  zone_id: slug.nullable(),
  commanded: z.number().min(0).max(100),
  observed: z.number().min(0).max(100).nullable(),
  ts: isoTimestamp,
});

export const wireTelemetryRange = z.object({
  greenhouse_id: slug,
  from: isoTimestamp,
  to: isoTimestamp,
  series: z.array(wireTelemetrySeries),
  actuators: z.array(wireActuatorState),
});

export const wireFleetSparklineSeries = z.object({
  greenhouse_id: slug,
  readings: z.array(wireReading),
});

export const wireFleetSparklines = z.object({
  from: isoTimestamp,
  to: isoTimestamp,
  metric: metricSchema,
  series: z.array(wireFleetSparklineSeries),
});

export const wireAnalyticsBucket = z.object({
  bucket_start: isoTimestamp,
  min: z.number(),
  max: z.number(),
  avg: z.number(),
  count: z.number().int().min(0),
});

export const wireAnalyticsSeries = z.object({
  metric: metricSchema,
  zone_id: slug.nullable(),
  buckets: z.array(wireAnalyticsBucket),
});

export const wireAnalyticsResponse = z.object({
  greenhouse_id: slug,
  from: isoTimestamp,
  to: isoTimestamp,
  interval: analyticsIntervalSchema,
  series: z.array(wireAnalyticsSeries),
});

export const wireEventEntry = z.object({
  greenhouse_id: slug,
  ts: isoTimestamp,
  kind: eventKindSchema,
  severity: eventSeveritySchema,
  message: z.string(),
  source: z.string().optional(),
});

export const wireTimeScalePatch = z.object({ scale: z.number().min(0.25).max(8) });

export const wireTimeScale = z.object({
  scale: z.number().min(0.25).max(8),
  tick_index: z.number().int().min(0),
  updated_at: isoTimestamp,
});

export const wireFleetTimeScaleResult = z.object({
  requested_scale: z.number().min(0.25).max(8),
  results: z.array(
    z.object({
      greenhouse_id: slug,
      applied: z.boolean(),
      scale: z.number().min(0.25).max(8).nullable(),
      detail: z.string().nullable(),
    }),
  ),
});

/** A rejected write (422), naming the violated field and bound. */
export const wireValidationError = z.object({
  error: z.string(),
  field: z.string(),
  bound: z.string(),
  value: z.unknown().optional(),
});

export const wireErrorBody = z.object({ error: z.string() });

export const wireFleet = z.array(wireGreenhouseSummary);
export const wireEventFeed = z.array(wireEventEntry);

// ---------------------------------------------------------------------------
// WebSocket wire frames (contracts/frontend-ws) — flat envelope + payload, strictly closed.
// ---------------------------------------------------------------------------

const wsEnvelope = {
  schema_version: z.number().int().min(1),
  greenhouse_id: slug,
  zone_id: slug.nullable(),
  ts: isoTimestamp,
};

/** A telemetry reading with its unit bound to the metric (mirrors the contract's conditional). */
export const wsReading = z
  .object({ metric: metricSchema, value: z.number(), unit: unitSchema })
  .strict()
  .superRefine((reading, ctx) => {
    if (METRIC_UNIT[reading.metric] !== reading.unit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unit"],
        message: `unit "${reading.unit}" does not match metric "${reading.metric}"`,
      });
    }
  });

export const wsActuatorSample = z
  .object({
    actuator: actuatorNameSchema,
    commanded: z.number().min(0).max(100),
    observed: z.number().min(0).max(100).nullable(),
  })
  .strict();

export const telemetryFrame = z
  .object({
    ...wsEnvelope,
    type: z.literal("telemetry"),
    readings: z.array(wsReading),
    actuators: z.array(wsActuatorSample).optional(),
  })
  .strict();

export const statusFrame = z
  .object({
    ...wsEnvelope,
    zone_id: z.null(),
    type: z.literal("status"),
    status: connectivitySchema,
    time_scale: z.number().min(0.25).max(8).optional(),
  })
  .strict();

export const driftFrame = z
  .object({
    ...wsEnvelope,
    zone_id: z.null(),
    type: z.literal("drift"),
    drift: z.boolean(),
  })
  .strict();

export const eventFrame = z
  .object({
    ...wsEnvelope,
    zone_id: z.null(),
    type: z.literal("event"),
    kind: eventKindSchema,
    severity: eventSeveritySchema,
    message: z.string(),
    source: z.string().optional(),
  })
  .strict();

/** Known frame schemas keyed by `type`; `ws.ts` dispatches on this and ignores unknown types. */
export const KNOWN_FRAME_SCHEMAS = {
  telemetry: telemetryFrame,
  status: statusFrame,
  drift: driftFrame,
  event: eventFrame,
} as const;

export type TelemetryFrame = z.infer<typeof telemetryFrame>;
export type StatusFrame = z.infer<typeof statusFrame>;
export type DriftFrame = z.infer<typeof driftFrame>;
export type EventFrame = z.infer<typeof eventFrame>;
export type KnownFrame = TelemetryFrame | StatusFrame | DriftFrame | EventFrame;
export type FrameType = keyof typeof KNOWN_FRAME_SCHEMAS;

// ---------------------------------------------------------------------------
// View-model types (camelCase) — what components consume
// ---------------------------------------------------------------------------

export type ZoneTargets = {
  zoneId: string;
  moistureLowThreshold: number;
  moistureHighThreshold: number;
  drainPeriodSecs: number;
  schedule: string;
};

export type ZoneStatus = {
  zoneId: string;
  soilMoistureVwc: number | null;
  irrigating: boolean;
  faulted: boolean;
  lastCycleTs: Date | null;
};

export type Setpoints = {
  temperatureDayC: number;
  temperatureNightC: number;
  dayStart: string;
  dayEnd: string;
  humidityLowPct: number;
  humidityHighPct: number;
  humidityDeadbandPct: number;
  co2TargetPpm: number;
  co2VentInterlockThresholdPct: number;
  vpdTargetKpa: number;
  dliTargetMol: number;
  zones: ZoneTargets[];
};

export type SetpointsPatch = Partial<Setpoints>;

export type GreenhouseClimate = {
  temperature?: number | null;
  humidity?: number | null;
  co2?: number | null;
  dli?: number | null;
};

export type GreenhouseSummary = {
  id: string;
  displayName: string;
  crop: string | null;
  status: Connectivity;
  drift: boolean;
  timeScale: number | null;
  climate: GreenhouseClimate;
};

export type GreenhouseDetail = {
  id: string;
  displayName: string;
  crop: string | null;
  status: Connectivity;
  drift: boolean;
  timeScale: number | null;
  setpoints: Setpoints;
  zoneStatus: ZoneStatus[];
};

export type GreenhouseRegistrationInput = {
  id: string;
  displayName: string;
  crop?: string | null;
  controller: { restBaseUrl: string; mqttTopicRoot: string };
};

export type Reading = { value: number; ts: Date };
export type TelemetrySeries = { metric: Metric; zoneId: string | null; readings: Reading[] };
export type ActuatorState = {
  actuator: ActuatorName;
  zoneId: string | null;
  commanded: number;
  observed: number | null;
  ts: Date;
};
export type TelemetryRange = {
  greenhouseId: string;
  from: Date;
  to: Date;
  series: TelemetrySeries[];
  actuators: ActuatorState[];
};

export type FleetSparklineSeries = { greenhouseId: string; readings: Reading[] };
export type FleetSparklines = {
  from: Date;
  to: Date;
  metric: Metric;
  series: FleetSparklineSeries[];
};

export type AnalyticsBucket = {
  bucketStart: Date;
  min: number;
  max: number;
  avg: number;
  count: number;
};
export type AnalyticsSeries = { metric: Metric; zoneId: string | null; buckets: AnalyticsBucket[] };
export type AnalyticsResponse = {
  greenhouseId: string;
  from: Date;
  to: Date;
  interval: AnalyticsInterval;
  series: AnalyticsSeries[];
};

export type EventEntry = {
  greenhouseId: string;
  ts: Date;
  kind: EventKind;
  severity: EventSeverity;
  message: string;
  source?: string;
};

export type TimeScale = { scale: number; tickIndex: number; updatedAt: Date };
export type FleetTimeScaleResult = {
  requestedScale: number;
  results: {
    greenhouseId: string;
    applied: boolean;
    scale: number | null;
    detail: string | null;
  }[];
};

// ---------------------------------------------------------------------------
// Adapters: wire (snake_case) → view-model (camelCase)
// ---------------------------------------------------------------------------

export const toZoneStatus = (w: z.infer<typeof wireZoneStatus>): ZoneStatus => ({
  zoneId: w.zone_id,
  soilMoistureVwc: w.soil_moisture_vwc,
  irrigating: w.irrigating,
  faulted: w.faulted,
  lastCycleTs: w.last_cycle_ts ? new Date(w.last_cycle_ts) : null,
});

export const toZoneTargets = (w: z.infer<typeof wireZoneTargets>): ZoneTargets => ({
  zoneId: w.zone_id,
  moistureLowThreshold: w.moisture_low_threshold,
  moistureHighThreshold: w.moisture_high_threshold,
  drainPeriodSecs: w.drain_period_secs,
  schedule: w.schedule,
});

export const toSetpoints = (w: z.infer<typeof wireSetpoints>): Setpoints => ({
  temperatureDayC: w.temperature_day_c,
  temperatureNightC: w.temperature_night_c,
  dayStart: w.day_start,
  dayEnd: w.day_end,
  humidityLowPct: w.humidity_low_pct,
  humidityHighPct: w.humidity_high_pct,
  humidityDeadbandPct: w.humidity_deadband_pct,
  co2TargetPpm: w.co2_target_ppm,
  co2VentInterlockThresholdPct: w.co2_vent_interlock_threshold_pct,
  vpdTargetKpa: w.vpd_target_kpa,
  dliTargetMol: w.dli_target_mol,
  zones: w.zones.map(toZoneTargets),
});

export const toGreenhouseSummary = (
  w: z.infer<typeof wireGreenhouseSummary>,
): GreenhouseSummary => ({
  id: w.id,
  displayName: w.display_name,
  crop: w.crop,
  status: w.status,
  drift: w.drift,
  timeScale: w.time_scale ?? null,
  climate: {
    temperature: w.climate?.temperature ?? null,
    humidity: w.climate?.humidity ?? null,
    co2: w.climate?.co2 ?? null,
    dli: w.climate?.dli ?? null,
  },
});

export const toGreenhouseDetail = (w: z.infer<typeof wireGreenhouseDetail>): GreenhouseDetail => ({
  id: w.id,
  displayName: w.display_name,
  crop: w.crop,
  status: w.status,
  drift: w.drift,
  timeScale: w.time_scale ?? null,
  setpoints: toSetpoints(w.setpoints),
  zoneStatus: w.zone_status.map(toZoneStatus),
});

export const toReading = (w: z.infer<typeof wireReading>): Reading => ({
  value: w.value,
  ts: new Date(w.ts),
});

export const toTelemetrySeries = (w: z.infer<typeof wireTelemetrySeries>): TelemetrySeries => ({
  metric: w.metric,
  zoneId: w.zone_id,
  readings: w.readings.map(toReading),
});

export const toActuatorState = (w: z.infer<typeof wireActuatorState>): ActuatorState => ({
  actuator: w.actuator,
  zoneId: w.zone_id,
  commanded: w.commanded,
  observed: w.observed,
  ts: new Date(w.ts),
});

export const toTelemetryRange = (w: z.infer<typeof wireTelemetryRange>): TelemetryRange => ({
  greenhouseId: w.greenhouse_id,
  from: new Date(w.from),
  to: new Date(w.to),
  series: w.series.map(toTelemetrySeries),
  actuators: w.actuators.map(toActuatorState),
});

export const toFleetSparklineSeries = (
  w: z.infer<typeof wireFleetSparklineSeries>,
): FleetSparklineSeries => ({
  greenhouseId: w.greenhouse_id,
  readings: w.readings.map(toReading),
});

export const toFleetSparklines = (w: z.infer<typeof wireFleetSparklines>): FleetSparklines => ({
  from: new Date(w.from),
  to: new Date(w.to),
  metric: w.metric,
  series: w.series.map(toFleetSparklineSeries),
});

export const toAnalyticsBucket = (w: z.infer<typeof wireAnalyticsBucket>): AnalyticsBucket => ({
  bucketStart: new Date(w.bucket_start),
  min: w.min,
  max: w.max,
  avg: w.avg,
  count: w.count,
});

export const toAnalyticsSeries = (w: z.infer<typeof wireAnalyticsSeries>): AnalyticsSeries => ({
  metric: w.metric,
  zoneId: w.zone_id,
  buckets: w.buckets.map(toAnalyticsBucket),
});

export const toAnalyticsResponse = (
  w: z.infer<typeof wireAnalyticsResponse>,
): AnalyticsResponse => ({
  greenhouseId: w.greenhouse_id,
  from: new Date(w.from),
  to: new Date(w.to),
  interval: w.interval,
  series: w.series.map(toAnalyticsSeries),
});

export const toEventEntry = (w: z.infer<typeof wireEventEntry>): EventEntry => ({
  greenhouseId: w.greenhouse_id,
  ts: new Date(w.ts),
  kind: w.kind,
  severity: w.severity,
  message: w.message,
  source: w.source,
});

export const toTimeScale = (w: z.infer<typeof wireTimeScale>): TimeScale => ({
  scale: w.scale,
  tickIndex: w.tick_index,
  updatedAt: new Date(w.updated_at),
});

export const toFleetTimeScaleResult = (
  w: z.infer<typeof wireFleetTimeScaleResult>,
): FleetTimeScaleResult => ({
  requestedScale: w.requested_scale,
  results: w.results.map((r) => ({
    greenhouseId: r.greenhouse_id,
    applied: r.applied,
    scale: r.scale,
    detail: r.detail,
  })),
});

// ---------------------------------------------------------------------------
// Encoders: view-model (camelCase) → wire (snake_case) for write bodies
// ---------------------------------------------------------------------------

export const toWireSetpointsPatch = (patch: SetpointsPatch): z.input<typeof wireSetpointsPatch> => {
  const wire: Record<string, unknown> = {};
  if (patch.temperatureDayC !== undefined) wire.temperature_day_c = patch.temperatureDayC;
  if (patch.temperatureNightC !== undefined) wire.temperature_night_c = patch.temperatureNightC;
  if (patch.dayStart !== undefined) wire.day_start = patch.dayStart;
  if (patch.dayEnd !== undefined) wire.day_end = patch.dayEnd;
  if (patch.humidityLowPct !== undefined) wire.humidity_low_pct = patch.humidityLowPct;
  if (patch.humidityHighPct !== undefined) wire.humidity_high_pct = patch.humidityHighPct;
  if (patch.humidityDeadbandPct !== undefined)
    wire.humidity_deadband_pct = patch.humidityDeadbandPct;
  if (patch.co2TargetPpm !== undefined) wire.co2_target_ppm = patch.co2TargetPpm;
  if (patch.co2VentInterlockThresholdPct !== undefined)
    wire.co2_vent_interlock_threshold_pct = patch.co2VentInterlockThresholdPct;
  if (patch.vpdTargetKpa !== undefined) wire.vpd_target_kpa = patch.vpdTargetKpa;
  if (patch.dliTargetMol !== undefined) wire.dli_target_mol = patch.dliTargetMol;
  if (patch.zones !== undefined)
    wire.zones = patch.zones.map((zone) => ({
      zone_id: zone.zoneId,
      moisture_low_threshold: zone.moistureLowThreshold,
      moisture_high_threshold: zone.moistureHighThreshold,
      drain_period_secs: zone.drainPeriodSecs,
      schedule: zone.schedule,
    }));
  return wire as z.input<typeof wireSetpointsPatch>;
};

export const toWireRegistration = (
  input: GreenhouseRegistrationInput,
): z.input<typeof wireGreenhouseRegistration> => ({
  id: input.id,
  display_name: input.displayName,
  crop: input.crop ?? null,
  controller: {
    rest_base_url: input.controller.restBaseUrl,
    mqtt_topic_root: input.controller.mqttTopicRoot,
  },
});

// ---------------------------------------------------------------------------
// Crop profiles & assignment (2b) — library entries and their greenhouse binding
// ---------------------------------------------------------------------------

/** A crop-safe [min, max] envelope for one scalar climate target (frontend-rest Bound). */
export const wireBound = z.object({ min: z.number(), max: z.number() });

/** A stage's crop-safe envelope for the numeric per-zone irrigation targets (frontend-rest ZoneBounds). */
export const wireZoneBounds = z.object({
  moisture_low_threshold: wireBound.optional(),
  moisture_high_threshold: wireBound.optional(),
  drain_period_secs: wireBound.optional(),
});

/** A stage's crop-safe envelope: an optional Bound per scalar climate target (frontend-rest StageBounds). */
export const wireStageBounds = z.object({
  temperature_day_c: wireBound.optional(),
  temperature_night_c: wireBound.optional(),
  humidity_low_pct: wireBound.optional(),
  humidity_high_pct: wireBound.optional(),
  humidity_deadband_pct: wireBound.optional(),
  co2_target_ppm: wireBound.optional(),
  co2_vent_interlock_threshold_pct: wireBound.optional(),
  vpd_target_kpa: wireBound.optional(),
  dli_target_mol: wireBound.optional(),
  zones: wireZoneBounds.optional(),
});

export const wireProfileStage = z.object({
  stage: z.string().min(1),
  targets: wireSetpoints,
  bounds: wireStageBounds.optional(),
});

export const wireCropProfile = z.object({
  id: slug,
  name: z.string().min(1),
  crop: z.string().min(1),
  stages: z.array(wireProfileStage).min(1),
});

export const wireProfileLibrary = z.array(wireCropProfile);

export const wireAssignment = z.object({
  greenhouse_id: slug,
  profile_id: slug,
  stage: z.string().min(1),
});

/** A crop-safe [min, max] envelope for one scalar climate target. */
export type Bound = { min: number; max: number };

/** The scalar climate setpoint keys that can carry a crop-safe envelope (all but time-of-day/zones). */
export type ScalarSetpointKey =
  | "temperatureDayC"
  | "temperatureNightC"
  | "humidityLowPct"
  | "humidityHighPct"
  | "humidityDeadbandPct"
  | "co2TargetPpm"
  | "co2VentInterlockThresholdPct"
  | "vpdTargetKpa"
  | "dliTargetMol";

/** The numeric per-zone irrigation keys that can carry a crop-safe envelope (schedule carries none). */
export type ZoneBoundKey = "moistureLowThreshold" | "moistureHighThreshold" | "drainPeriodSecs";

/** A stage's crop-safe envelope for the numeric per-zone irrigation targets, applied to every zone. */
export type ZoneBounds = Partial<Record<ZoneBoundKey, Bound>>;

/** A stage's crop-safe envelope: an optional Bound per scalar climate target, plus a per-zone envelope. */
export type StageBounds = Partial<Record<ScalarSetpointKey, Bound>> & { zones?: ZoneBounds };

export type ProfileStage = { stage: string; targets: Setpoints; bounds?: StageBounds };
export type CropProfile = { id: string; name: string; crop: string; stages: ProfileStage[] };
export type Assignment = { greenhouseId: string; profileId: string; stage: string };
export type AssignmentInput = { profileId: string; stage: string };

// Pairs each envelope target's camelCase view key with its snake_case wire key — the single table
// the StageBounds adapters iterate so encode/decode stay in lockstep.
const BOUND_KEYS: [ScalarSetpointKey, Exclude<keyof z.infer<typeof wireStageBounds>, "zones">][] = [
  ["temperatureDayC", "temperature_day_c"],
  ["temperatureNightC", "temperature_night_c"],
  ["humidityLowPct", "humidity_low_pct"],
  ["humidityHighPct", "humidity_high_pct"],
  ["humidityDeadbandPct", "humidity_deadband_pct"],
  ["co2TargetPpm", "co2_target_ppm"],
  ["co2VentInterlockThresholdPct", "co2_vent_interlock_threshold_pct"],
  ["vpdTargetKpa", "vpd_target_kpa"],
  ["dliTargetMol", "dli_target_mol"],
];

// The per-zone envelope counterpart to BOUND_KEYS.
const ZONE_BOUND_KEYS: [ZoneBoundKey, keyof z.infer<typeof wireZoneBounds>][] = [
  ["moistureLowThreshold", "moisture_low_threshold"],
  ["moistureHighThreshold", "moisture_high_threshold"],
  ["drainPeriodSecs", "drain_period_secs"],
];

export const toZoneBounds = (w: z.infer<typeof wireZoneBounds>): ZoneBounds => {
  const bounds: ZoneBounds = {};
  for (const [key, wireKey] of ZONE_BOUND_KEYS) {
    const b = w[wireKey];
    if (b) bounds[key] = { min: b.min, max: b.max };
  }
  return bounds;
};

export const toWireZoneBounds = (bounds: ZoneBounds): z.input<typeof wireZoneBounds> => {
  const wire: z.input<typeof wireZoneBounds> = {};
  for (const [key, wireKey] of ZONE_BOUND_KEYS) {
    const b = bounds[key];
    if (b) wire[wireKey] = { min: b.min, max: b.max };
  }
  return wire;
};

export const toStageBounds = (w: z.infer<typeof wireStageBounds>): StageBounds => {
  const bounds: StageBounds = {};
  for (const [key, wireKey] of BOUND_KEYS) {
    const b = w[wireKey];
    if (b) bounds[key] = { min: b.min, max: b.max };
  }
  if (w.zones) bounds.zones = toZoneBounds(w.zones);
  return bounds;
};

export const toWireStageBounds = (bounds: StageBounds): z.input<typeof wireStageBounds> => {
  const wire: z.input<typeof wireStageBounds> = {};
  for (const [key, wireKey] of BOUND_KEYS) {
    const b = bounds[key];
    if (b) wire[wireKey] = { min: b.min, max: b.max };
  }
  if (bounds.zones) wire.zones = toWireZoneBounds(bounds.zones);
  return wire;
};

export const toProfileStage = (w: z.infer<typeof wireProfileStage>): ProfileStage => {
  const stage: ProfileStage = { stage: w.stage, targets: toSetpoints(w.targets) };
  if (w.bounds) stage.bounds = toStageBounds(w.bounds);
  return stage;
};

export const toCropProfile = (w: z.infer<typeof wireCropProfile>): CropProfile => ({
  id: w.id,
  name: w.name,
  crop: w.crop,
  stages: w.stages.map(toProfileStage),
});

export const toAssignment = (w: z.infer<typeof wireAssignment>): Assignment => ({
  greenhouseId: w.greenhouse_id,
  profileId: w.profile_id,
  stage: w.stage,
});

const toWireZoneTargets = (zone: ZoneTargets): z.input<typeof wireZoneTargets> => ({
  zone_id: zone.zoneId,
  moisture_low_threshold: zone.moistureLowThreshold,
  moisture_high_threshold: zone.moistureHighThreshold,
  drain_period_secs: zone.drainPeriodSecs,
  schedule: zone.schedule,
});

/** Encode a full setpoint bundle (a crop-profile stage's targets) to the wire shape. */
export const toWireSetpoints = (setpoints: Setpoints): z.input<typeof wireSetpoints> => ({
  temperature_day_c: setpoints.temperatureDayC,
  temperature_night_c: setpoints.temperatureNightC,
  day_start: setpoints.dayStart,
  day_end: setpoints.dayEnd,
  humidity_low_pct: setpoints.humidityLowPct,
  humidity_high_pct: setpoints.humidityHighPct,
  humidity_deadband_pct: setpoints.humidityDeadbandPct,
  co2_target_ppm: setpoints.co2TargetPpm,
  co2_vent_interlock_threshold_pct: setpoints.co2VentInterlockThresholdPct,
  vpd_target_kpa: setpoints.vpdTargetKpa,
  dli_target_mol: setpoints.dliTargetMol,
  zones: setpoints.zones.map(toWireZoneTargets),
});

const toWireProfileStage = (stage: ProfileStage): z.input<typeof wireProfileStage> => ({
  stage: stage.stage,
  targets: toWireSetpoints(stage.targets),
  ...(stage.bounds ? { bounds: toWireStageBounds(stage.bounds) } : {}),
});

export const toWireCropProfile = (profile: CropProfile): z.input<typeof wireCropProfile> => ({
  id: profile.id,
  name: profile.name,
  crop: profile.crop,
  stages: profile.stages.map(toWireProfileStage),
});

/** Encode a profile edit as a CropProfilePatch (id is immutable — path identity only). */
export const toWireCropProfilePatch = (
  profile: CropProfile,
): { name: string; crop: string; stages: z.input<typeof wireProfileStage>[] } => ({
  name: profile.name,
  crop: profile.crop,
  stages: profile.stages.map(toWireProfileStage),
});

export const toWireAssignmentInput = (
  input: AssignmentInput,
): { profile_id: string; stage: string } => ({
  profile_id: input.profileId,
  stage: input.stage,
});
