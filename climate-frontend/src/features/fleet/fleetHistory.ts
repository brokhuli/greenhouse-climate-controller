import type { FleetSparklines, Reading } from "../../api/schemas";

const NO_READINGS: readonly Reading[] = [];

/** Index a batched fleet-sparkline response by greenhouse id for O(1) per-card lookup. */
export function indexFleetHistory(
  data: FleetSparklines | undefined,
): Map<string, readonly Reading[]> {
  const byGreenhouse = new Map<string, readonly Reading[]>();
  if (!data) return byGreenhouse;
  for (const series of data.series) byGreenhouse.set(series.greenhouseId, series.readings);
  return byGreenhouse;
}

/** A greenhouse's seeded history, or a shared empty array when it has none in the window. */
export function historyFor(
  index: Map<string, readonly Reading[]>,
  greenhouseId: string,
): readonly Reading[] {
  return index.get(greenhouseId) ?? NO_READINGS;
}
