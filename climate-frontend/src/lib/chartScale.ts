/**
 * Pure chart-scale helpers. Kept in `lib/` so the numeric logic stays unit-testable, away from the
 * uPlot/canvas glue that consumes it.
 */

/**
 * Fit a sparkline's y-range tightly to its data with a little headroom on each side, so the line
 * uses the tile's height instead of floating against a wide range (the card chart has no y labels,
 * so there's no reason to snap out to round numbers). Flat data falls back to a small symmetric span
 * so the bounds never collapse to a zero-height range.
 */
export function sparklineBounds(dataMin: number, dataMax: number): [number, number] {
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) return [dataMin, dataMax];
  const span = dataMax - dataMin;
  if (span < 1e-9) {
    const pad = Math.max(Math.abs(dataMin) * 0.05, 0.5);
    return [dataMin - pad, dataMax + pad];
  }
  const pad = span * 0.15;
  return [dataMin - pad, dataMax + pad];
}
