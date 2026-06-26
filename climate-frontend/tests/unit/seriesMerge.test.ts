import { describe, expect, it } from "vitest";
import { mergeReadings } from "../../src/lib/derivations";
import type { Reading } from "../../src/api/schemas";

const reading = (millis: number, value: number): Reading => ({ value, ts: new Date(millis) });

describe("mergeReadings", () => {
  it("merges history and live into one ascending, deduplicated point list (live wins)", () => {
    const history = [reading(1000, 10), reading(2000, 20)];
    const live = [reading(2000, 22), reading(3000, 30)];
    const points = mergeReadings(history, live);
    expect(points.map((point) => point.t)).toEqual([1, 2, 3]);
    expect(points.map((point) => point.v)).toEqual([10, 22, 30]); // live overrides ts=2000
  });

  it("drops points older than the window relative to the newest point", () => {
    const history = [reading(0, 1), reading(60_000, 2), reading(120_000, 3)];
    const points = mergeReadings(history, [], { windowMs: 60_000 });
    expect(points.map((point) => point.v)).toEqual([2, 3]);
  });

  it("returns an empty list when there are no readings", () => {
    expect(mergeReadings([], [])).toEqual([]);
  });
});
