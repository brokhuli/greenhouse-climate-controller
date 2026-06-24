import { useMemo } from "react";
import type { Metric, Reading } from "../api/schemas";

/**
 * Per-metric live ring buffer for the visible chart window.
 *
 * STUB: the real hook lands with the detail-chart feature slice, wired to `ws.ts` — it will keep
 * the last N seconds of streaming readings per metric and feed `TimeSeriesChart` directly
 * (architecture §4 "WS carries the live edge"). For now it returns an empty buffer so the chart
 * shell can compile against its shape.
 */
export type LiveSeries = ReadonlyMap<Metric, readonly Reading[]>;

export function useLiveSeries(): LiveSeries {
  return useMemo(() => new Map<Metric, readonly Reading[]>(), []);
}
