import type { AnalyticsResponse, Metric, Reading, TelemetryRange } from "../../api/schemas";

/**
 * Pull one metric+zone's historical readings out of whichever query backs the current range
 * (architecture §4): raw telemetry for short ranges, time-bucketed analytics (the bucket average)
 * for long ones. Pure so the chart's history half is testable without the network.
 */
export function telemetryReadings(
  range: TelemetryRange | undefined,
  metric: Metric,
  zoneId: string | null,
): Reading[] {
  const series = range?.series.find((entry) => entry.metric === metric && entry.zoneId === zoneId);
  return series ? series.readings : [];
}

export function analyticsReadings(
  response: AnalyticsResponse | undefined,
  metric: Metric,
  zoneId: string | null,
): Reading[] {
  const series = response?.series.find(
    (entry) => entry.metric === metric && entry.zoneId === zoneId,
  );
  return series
    ? series.buckets.map((bucket) => ({ value: bucket.avg, ts: bucket.bucketStart }))
    : [];
}
