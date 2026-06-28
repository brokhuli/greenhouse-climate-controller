/**
 * Pure layout math for the stacked climate chart. The chart draws several metrics in one uPlot
 * instance by mapping each metric into its own vertical sub-band of a single unitless [0,1] y-scale
 * (uPlot stacks multiple real y-axes into separate columns, which can't reproduce a single tick
 * column). These helpers are kept in `lib/` so the numeric logic stays unit-testable, away from the
 * uPlot/canvas glue that consumes it.
 */

/** A vertical sub-range of the plot in y-scale fraction units (`0` = bottom edge, `1` = top edge). */
export type Band = { bottom: number; top: number };

/** A band's native-unit domain rounded out to nice numbers, with ascending ticks across it. */
export type BandScale = { lo: number; hi: number; ticks: number[] };

/**
 * Split `[0, 1]` top-to-bottom into `count` equal bands separated by `gap`. Index `0` is the
 * topmost band (highest fractions), matching the order metrics are listed top-to-bottom.
 */
export function bandFractions(count: number, gap: number): Band[] {
  if (count <= 0) return [];
  const height = (1 - gap * (count - 1)) / count;
  const bands: Band[] = [];
  for (let index = 0; index < count; index += 1) {
    const top = 1 - index * (height + gap);
    bands.push({ bottom: top - height, top });
  }
  return bands;
}

/** The "nice" 1/2/5/10 number at or around `range`'s magnitude (Heckbert's tick rounding). */
function niceNum(range: number, round: boolean): number {
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / Math.pow(10, exponent);
  const niceFraction = round
    ? fraction < 1.5
      ? 1
      : fraction < 3
        ? 2
        : fraction < 7
          ? 5
          : 10
    : fraction <= 1
      ? 1
      : fraction <= 2
        ? 2
        : fraction <= 5
          ? 5
          : 10;
  return niceFraction * Math.pow(10, exponent);
}

/**
 * Build a padded, nicely-rounded native-unit domain plus ~`maxTicks` round ticks for a band's value
 * span. Flat (or empty) spans fall back to a small symmetric range so the band never collapses.
 */
export function bandScale(min: number, max: number, maxTicks = 3): BandScale {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };

  let lo = min;
  let hi = max;
  if (hi - lo < 1e-9) {
    const pad = Math.max(Math.abs(lo) * 0.05, 0.5);
    lo -= pad;
    hi += pad;
  }

  const step = niceNum((hi - lo) / Math.max(1, maxTicks - 1), true);
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const round = (value: number): number => Number(value.toFixed(decimals));

  const niceLo = round(Math.floor(lo / step) * step);
  const niceHi = round(Math.ceil(hi / step) * step);
  const ticks: number[] = [];
  for (let value = niceLo; value <= niceHi + step * 0.5; value += step) ticks.push(round(value));
  return { lo: niceLo, hi: niceHi, ticks };
}

/** Map a native-unit value into its band's fraction range, clamped to the band's edges. */
export function toBandFraction(
  value: number,
  scale: Pick<BandScale, "lo" | "hi">,
  band: Band,
): number {
  const span = scale.hi - scale.lo;
  const normalized = span < 1e-9 ? 0.5 : (value - scale.lo) / span;
  const clamped = Math.min(1, Math.max(0, normalized));
  return band.bottom + clamped * (band.top - band.bottom);
}
