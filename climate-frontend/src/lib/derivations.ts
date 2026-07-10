import type {
  AnalyticsInterval,
  Connectivity,
  EventEntry,
  GreenhouseSummary,
  Reading,
  Setpoints,
} from "../api/schemas";

/**
 * Pure view-model derivations (data-model spec §8). They turn raw API data into what the UI shows,
 * are unit-tested in isolation, and are never inlined into components — so a view never recomputes
 * climate logic and the rules stay testable.
 */

// ---------------------------------------------------------------------------
// Reading vs setpoint
// ---------------------------------------------------------------------------

export type ReadingDelta = {
  /** reading − setpoint, or null when either is unavailable. */
  delta: number | null;
  direction: "above" | "below" | "equal" | "unknown";
};

/** The signed gap between a current reading and its setpoint (detail metric tiles, fleet card). */
export function readingVsSetpointDelta(
  reading: number | null | undefined,
  setpoint: number | null | undefined,
): ReadingDelta {
  if (reading == null || setpoint == null) return { delta: null, direction: "unknown" };
  const delta = reading - setpoint;
  const direction = delta > 0 ? "above" : delta < 0 ? "below" : "equal";
  return { delta, direction };
}

/** Resolve the active day/night temperature setpoint for a simulated timestamp. */
export function activeTemperatureSetpoint(
  setpoints: Setpoints,
  instant: Date | null | undefined,
): { label: "Day" | "Night"; value: number } {
  if (!instant) return { label: "Day", value: setpoints.temperatureDayC };

  const [startHour, startMinute] = parseTimeOfDay(setpoints.dayStart);
  const [endHour, endMinute] = parseTimeOfDay(setpoints.dayEnd);
  const nowMinutes = instant.getUTCHours() * 60 + instant.getUTCMinutes();
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  const isDay =
    startMinutes <= endMinutes
      ? nowMinutes >= startMinutes && nowMinutes < endMinutes
      : nowMinutes >= startMinutes || nowMinutes < endMinutes;

  return isDay
    ? { label: "Day", value: setpoints.temperatureDayC }
    : { label: "Night", value: setpoints.temperatureNightC };
}

function parseTimeOfDay(value: string): [number, number] {
  const [hour, minute] = value.split(":").map((part) => Number.parseInt(part, 10));
  return [hour, minute];
}

// ---------------------------------------------------------------------------
// Fleet status rollup
// ---------------------------------------------------------------------------

export type StatusRollup = Record<Connectivity, number> & {
  total: number;
  drift: number;
};

/** Site-wide rollup of per-greenhouse connectivity + drift (fleet summary bar). */
export function statusRollup(summaries: readonly GreenhouseSummary[]): StatusRollup {
  const rollup: StatusRollup = { total: 0, online: 0, degraded: 0, offline: 0, drift: 0 };
  for (const summary of summaries) {
    rollup.total += 1;
    rollup[summary.status] += 1;
    if (summary.drift) rollup.drift += 1;
  }
  return rollup;
}

// ---------------------------------------------------------------------------
// Active faults
// ---------------------------------------------------------------------------

/**
 * How many of a greenhouse's recent events are faults (the detail summary's Status tile). The feed
 * carries no resolved/active flag, so this counts fault-kind entries in the current window — a close
 * enough proxy for "active faults" while a greenhouse is degraded.
 */
export function activeFaultCount(events: readonly EventEntry[]): number {
  let count = 0;
  for (const event of events) {
    if (event.kind === "fault") count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Range-tier selection (raw telemetry vs aggregated analytics)
// ---------------------------------------------------------------------------

export type RangeTier = { tier: "raw" } | { tier: "aggregate"; interval: AnalyticsInterval };

const INTERVAL_SECONDS: ReadonlyArray<readonly [AnalyticsInterval, number]> = [
  ["5m", 5 * 60],
  ["15m", 15 * 60],
  ["1h", 60 * 60],
  ["6h", 6 * 60 * 60],
  ["1d", 24 * 60 * 60],
];

export type RangeTierOptions = {
  /** Above this range, switch to aggregates. Default ~24 h. */
  rawThresholdMs?: number;
  /** Target upper bound on bucket count so the chart stays light. Default 500. */
  maxBuckets?: number;
};

/**
 * Pick raw telemetry for short ranges and time-bucketed analytics for long ones, choosing the
 * smallest interval that keeps the bucket count under `maxBuckets` (architecture §4).
 */
export function rangeTierSelection(rangeMs: number, options: RangeTierOptions = {}): RangeTier {
  const rawThresholdMs = options.rawThresholdMs ?? 24 * 60 * 60 * 1000;
  const maxBuckets = options.maxBuckets ?? 500;

  if (rangeMs <= rawThresholdMs) return { tier: "raw" };

  const rangeSeconds = rangeMs / 1000;
  for (const [interval, seconds] of INTERVAL_SECONDS) {
    if (rangeSeconds / seconds <= maxBuckets) return { tier: "aggregate", interval };
  }
  return { tier: "aggregate", interval: "1d" };
}

// ---------------------------------------------------------------------------
// Series merge (historical query data + live ring buffer → chart points)
// ---------------------------------------------------------------------------

/** A chart point in uPlot's native units: `t` is epoch *seconds*, `v` the value. */
export type SeriesPoint = { t: number; v: number };

export type MergeOptions = {
  /** Drop points older than this many ms behind the newest point (the visible window). */
  windowMs?: number;
};

/**
 * Merge a metric's historical readings with its live ring buffer into a single ascending,
 * timestamp-deduplicated point list (architecture §4: history from the Query cache, the live edge
 * from `ws.ts`). Live readings win on an exact-timestamp collision. Memoize the call site so a
 * frame for one greenhouse doesn't recompute another's chart (components §5).
 */
export function mergeReadings(
  historical: readonly Reading[],
  live: readonly Reading[],
  options: MergeOptions = {},
): SeriesPoint[] {
  const byMillis = new Map<number, number>();
  for (const reading of historical) byMillis.set(reading.ts.getTime(), reading.value);
  for (const reading of live) byMillis.set(reading.ts.getTime(), reading.value);

  let points = Array.from(byMillis, ([millis, value]) => ({ t: millis / 1000, v: value })).sort(
    (a, b) => a.t - b.t,
  );

  if (options.windowMs !== undefined && points.length > 0) {
    const cutoff = points[points.length - 1].t - options.windowMs / 1000;
    points = points.filter((point) => point.t >= cutoff);
  }
  return points;
}

/**
 * Align several already-merged metric series onto one shared, ascending x axis. uPlot's
 * `AlignedData` requires every series to share the x row, but the stacked climate chart merges each
 * metric independently (and live points can land on differing timestamps). This builds the sorted
 * union of timestamps and fills each series with `null` where it has no sample at that x — uPlot
 * renders the nulls as line breaks rather than interpolating across a gap.
 */
export function alignSeries(seriesList: readonly (readonly SeriesPoint[])[]): {
  xs: number[];
  ys: (number | null)[][];
} {
  const timestamps = new Set<number>();
  for (const series of seriesList) {
    for (const point of series) timestamps.add(point.t);
  }
  const xs = [...timestamps].sort((a, b) => a - b);
  const indexByX = new Map(xs.map((x, index) => [x, index]));

  const ys = seriesList.map((series) => {
    const row: (number | null)[] = new Array(xs.length).fill(null);
    for (const point of series) row[indexByX.get(point.t)!] = point.v;
    return row;
  });
  return { xs, ys };
}

// ---------------------------------------------------------------------------
// Zone irrigation status (soil-moisture card)
// ---------------------------------------------------------------------------

export type ZoneMoistureStatusKind = "ok" | "dry" | "wet" | "watering" | "fault" | "unknown";

export type ZoneMoistureStatus = {
  kind: ZoneMoistureStatusKind;
  label: string;
  /** CSS custom property backing the status colour (tokens.css). */
  colorVar: string;
};

export type ZoneMoistureInputs = {
  moistureVwc: number | null;
  lowThreshold: number;
  highThreshold: number;
  irrigating: boolean;
  faulted: boolean;
};

/**
 * Resolve a zone's single headline status for the soil-moisture card. Precedence, most urgent
 * first: a faulted zone reads as Fault; a missing reading is No data; an open valve is Watering; a
 * reading below the low threshold is Dry and one above the high threshold is Saturated; otherwise
 * OK. Dry and Saturated are the two out-of-band sides and share the warning colour; OK keeps green
 * for in-band only. Colour always travels with a text label — the design system forbids colour-only
 * status.
 */
export function zoneMoistureStatus(inputs: ZoneMoistureInputs): ZoneMoistureStatus {
  const { moistureVwc, lowThreshold, highThreshold, faulted, irrigating } = inputs;
  if (faulted) return { kind: "fault", label: "Fault", colorVar: "--color-fault" };
  if (moistureVwc == null)
    return { kind: "unknown", label: "No data", colorVar: "--color-fg-muted" };
  if (irrigating) return { kind: "watering", label: "Watering", colorVar: "--color-info" };
  if (moistureVwc < lowThreshold) return { kind: "dry", label: "Dry", colorVar: "--color-warning" };
  if (moistureVwc > highThreshold)
    return { kind: "wet", label: "Saturated", colorVar: "--color-warning" };
  return { kind: "ok", label: "OK", colorVar: "--color-status-online" };
}

/**
 * Position a VWC reading on the full 0–1 moisture-bar scale (the bar spans 0–100 % VWC, split into
 * dry/target/wet regions at the thresholds): the reading itself, clamped to 0–1, or null when there
 * is no reading.
 */
export function moistureScalePosition(moistureVwc: number | null): number | null {
  if (moistureVwc == null) return null;
  return moistureVwc < 0 ? 0 : moistureVwc > 1 ? 1 : moistureVwc;
}

export type MoistureFillSpans = {
  /** Clamped band boundaries (0–1), exposed so the bar can mark each section start. */
  low: number;
  high: number;
  /** Width (0–1 of the full scale) the reading colours within each band; null reading ⇒ all 0. */
  dry: number;
  target: number;
  wet: number;
};

/**
 * Split the moisture bar into its three band-tinted fill spans for a reading. The bar fills like a
 * gauge — colour runs from 0 up to the reading only — so each band (dry 0–low, target low–high, wet
 * high–1) is tinted just over the portion the reading covers and stays on the dark track above it.
 * `dry + target + wet` equals the clamped reading; a null reading yields all zeros (a fully dark bar).
 */
const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

export function moistureFillSpans(
  moistureVwc: number | null,
  lowThreshold: number,
  highThreshold: number,
): MoistureFillSpans {
  const low = clamp01(lowThreshold);
  const high = Math.max(low, clamp01(highThreshold));
  const fill = moistureVwc == null ? 0 : clamp01(moistureVwc);
  return {
    low,
    high,
    dry: Math.min(fill, low),
    target: Math.max(0, Math.min(fill, high) - low),
    wet: Math.max(0, fill - high),
  };
}

/**
 * "Last watered" label for a zone's last cycle end: "Today, 8:00 AM" on the same calendar day,
 * "Jun 24, 8:00 AM" otherwise, "Never" when the zone has not cycled. `now` is injectable so the
 * today/other-day branch is deterministic in tests. Rendered in UTC — the greenhouse's simulated
 * wall-clock frame (see lib/timeFormat.ts) — so the time reads the hour the simulated clock shows.
 */
export function formatLastWatered(ts: Date | null, now: Date = new Date()): string {
  if (!ts) return "Never";
  const time = ts.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  if (isSameUTCDay(ts, now)) return `Today, ${time}`;
  const date = ts.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${date}, ${time}`;
}

function isSameUTCDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/** Title-case a label for display, splitting on spaces or hyphens: "greenhouse a" → "Greenhouse A". */
function titleCaseLabel(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Prettify a zone slug for display: "bench-a" → "Bench A". */
export function formatZoneLabel(zoneId: string): string {
  return titleCaseLabel(zoneId);
}

/** Prettify a greenhouse display name for display: "greenhouse a" → "Greenhouse A". */
export function formatGreenhouseLabel(name: string): string {
  return titleCaseLabel(name);
}

/** Render an irrigation schedule ("06:00,14:00") with comma-space separators for display. */
export function formatSchedule(schedule: string): string {
  return schedule
    .split(",")
    .map((time) => time.trim())
    .filter((time) => time.length > 0)
    .join(", ");
}
