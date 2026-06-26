import type { FleetSparklines, Metric, Reading } from "../../api/schemas";

const NO_READINGS: readonly Reading[] = [];

/** Per-greenhouse, per-metric seeded history: `greenhouse id → metric → readings`. */
export type MetricHistory = ReadonlyMap<Metric, readonly Reading[]>;
export type FleetHistory = Map<string, Map<Metric, readonly Reading[]>>;

const NO_METRIC_HISTORY: MetricHistory = new Map();

/** Index a batched fleet-sparkline response by greenhouse id, then metric, for O(1) per-card lookup. */
export function indexFleetHistory(data: FleetSparklines | undefined): FleetHistory {
  const byGreenhouse: FleetHistory = new Map();
  if (!data) return byGreenhouse;
  for (const series of data.series) {
    const byMetric = new Map<Metric, readonly Reading[]>();
    for (const metric of series.metrics) byMetric.set(metric.metric, metric.readings);
    byGreenhouse.set(series.greenhouseId, byMetric);
  }
  return byGreenhouse;
}

/** A greenhouse's seeded per-metric history, or a shared empty map when it has none in the window. */
export function historyForGreenhouse(index: FleetHistory, greenhouseId: string): MetricHistory {
  return index.get(greenhouseId) ?? NO_METRIC_HISTORY;
}

/** A greenhouse+metric's seeded history, or a shared empty array when it has none in the window. */
export function historyFor(
  index: FleetHistory,
  greenhouseId: string,
  metric: Metric,
): readonly Reading[] {
  return index.get(greenhouseId)?.get(metric) ?? NO_READINGS;
}
