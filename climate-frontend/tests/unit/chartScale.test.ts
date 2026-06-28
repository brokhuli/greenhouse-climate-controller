import { describe, expect, it } from "vitest";
import { sparklineBounds } from "../../src/lib/chartScale";

describe("sparklineBounds", () => {
  it("pads a range by a fraction of its span on each side", () => {
    expect(sparklineBounds(10, 20)).toEqual([8.5, 21.5]); // 15% of a span of 10
  });

  it("keeps the line off the top and bottom edges", () => {
    const [low, high] = sparklineBounds(16.7, 16.95);
    expect(low).toBeLessThan(16.7);
    expect(high).toBeGreaterThan(16.95);
  });

  it("widens flat data so the range never collapses to zero height", () => {
    const [low, high] = sparklineBounds(22, 22);
    expect(high).toBeGreaterThan(low);
  });

  it("gives flat data near zero a usable span", () => {
    expect(sparklineBounds(0, 0)).toEqual([-0.5, 0.5]);
  });

  it("passes non-finite inputs through unchanged", () => {
    expect(sparklineBounds(NaN, 5)).toEqual([NaN, 5]);
  });
});
