import type { AnalyticsInterval, Connectivity, GreenhouseSummary } from "../api/schemas";

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
