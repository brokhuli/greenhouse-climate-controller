import { describe, expect, it } from "vitest";
import { wholeNumberBounds } from "../../src/lib/chartScale";

describe("wholeNumberBounds", () => {
  it("expands a between-integers range out to whole numbers", () => {
    expect(wholeNumberBounds(8.4, 8.8)).toEqual([8, 9]);
  });

  it("keeps already-whole bounds", () => {
    expect(wholeNumberBounds(21, 23)).toEqual([21, 23]);
  });

  it("floors the min and ceils the max", () => {
    expect(wholeNumberBounds(21.2, 22.9)).toEqual([21, 23]);
  });

  it("widens flat integer data so the range never collapses", () => {
    expect(wholeNumberBounds(22, 22)).toEqual([21, 23]);
  });

  it("gives flat between-integers data a unit span", () => {
    expect(wholeNumberBounds(8.5, 8.5)).toEqual([8, 9]);
  });

  it("passes non-finite inputs through unchanged", () => {
    expect(wholeNumberBounds(NaN, 5)).toEqual([NaN, 5]);
  });
});
