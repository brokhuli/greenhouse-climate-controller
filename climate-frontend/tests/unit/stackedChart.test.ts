import { describe, expect, it } from "vitest";
import { bandFractions, bandScale, toBandFraction } from "../../src/lib/stackedChart";

describe("bandFractions", () => {
  it("splits [0,1] top-to-bottom into equal bands separated by the gap", () => {
    const bands = bandFractions(4, 0.06);
    expect(bands).toHaveLength(4);
    // index 0 is the topmost band, index 3 the bottom one
    expect(bands[0].top).toBeCloseTo(1);
    expect(bands[3].bottom).toBeCloseTo(0);
    // every band shares the same height
    const heights = bands.map((band) => band.top - band.bottom);
    for (const height of heights) expect(height).toBeCloseTo(heights[0]);
    // the gap sits between consecutive bands
    expect(bands[0].bottom - bands[1].top).toBeCloseTo(0.06);
  });

  it("returns an empty list for a non-positive count", () => {
    expect(bandFractions(0, 0.06)).toEqual([]);
  });
});

describe("bandScale", () => {
  it("rounds the domain out to nice numbers and emits ascending ticks", () => {
    const { lo, hi, ticks } = bandScale(701, 899);
    expect(lo).toBeLessThanOrEqual(701);
    expect(hi).toBeGreaterThanOrEqual(899);
    expect(ticks[0]).toBe(lo);
    expect(ticks.at(-1)).toBe(hi);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
  });

  it("expands a flat span so the band never collapses to zero height", () => {
    const { lo, hi } = bandScale(20, 20);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("toBandFraction", () => {
  const band = { bottom: 0.5, top: 1 };
  const scale = { lo: 0, hi: 100 };

  it("maps the domain ends onto the band edges and the midpoint to the band middle", () => {
    expect(toBandFraction(0, scale, band)).toBeCloseTo(0.5);
    expect(toBandFraction(100, scale, band)).toBeCloseTo(1);
    expect(toBandFraction(50, scale, band)).toBeCloseTo(0.75);
  });

  it("clamps values outside the domain to the band edges", () => {
    expect(toBandFraction(200, scale, band)).toBeCloseTo(1);
    expect(toBandFraction(-50, scale, band)).toBeCloseTo(0.5);
  });
});
