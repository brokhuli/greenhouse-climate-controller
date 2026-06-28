import { describe, expect, it } from "vitest";
import { alignSeries } from "../../src/lib/derivations";
import type { SeriesPoint } from "../../src/lib/derivations";

const point = (t: number, v: number): SeriesPoint => ({ t, v });

describe("alignSeries", () => {
  it("builds the sorted union of timestamps and null-fills gaps per series", () => {
    const temperature = [point(1, 10), point(3, 30)];
    const humidity = [point(2, 70), point(3, 72)];
    const { xs, ys } = alignSeries([temperature, humidity]);
    expect(xs).toEqual([1, 2, 3]);
    expect(ys[0]).toEqual([10, null, 30]); // no temperature sample at t=2
    expect(ys[1]).toEqual([null, 70, 72]); // no humidity sample at t=1
  });

  it("keeps one row per input series even when a series is empty", () => {
    const { xs, ys } = alignSeries([[point(5, 1)], []]);
    expect(xs).toEqual([5]);
    expect(ys).toEqual([[1], [null]]);
  });

  it("returns empty x and one empty row per series when there are no points", () => {
    expect(alignSeries([[], []])).toEqual({ xs: [], ys: [[], []] });
  });
});
