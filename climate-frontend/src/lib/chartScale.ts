/**
 * Pure chart-scale helpers. Kept in `lib/` so the numeric logic stays unit-testable, away from the
 * uPlot/canvas glue that consumes it.
 */

/**
 * Snap a data range out to whole-number bounds so an integer y-tick always falls inside the visible
 * range (the card y-axis only allows integer increments, which otherwise renders blank when the data
 * sits between two integers, e.g. 8.4–8.8). Flat integer data is widened so the bounds never collapse
 * to a zero-height range.
 */
export function wholeNumberBounds(dataMin: number, dataMax: number): [number, number] {
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return [dataMin, dataMax];
  const low = Math.floor(dataMin);
  const high = Math.ceil(dataMax);
  return low === high ? [low - 1, high + 1] : [low, high];
}
