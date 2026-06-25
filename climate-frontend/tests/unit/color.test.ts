import { describe, expect, it } from "vitest";
import { withAlpha } from "../../src/lib/color";

describe("withAlpha", () => {
  it("converts a 6-digit hex to rgba with the given alpha", () => {
    expect(withAlpha("#9ccc65", 0.2)).toBe("rgba(156, 204, 101, 0.2)");
  });

  it("supports a fully transparent stop", () => {
    expect(withAlpha("#9ccc65", 0)).toBe("rgba(156, 204, 101, 0)");
  });

  it("expands 3-digit shorthand hex", () => {
    expect(withAlpha("#fff", 0.5)).toBe("rgba(255, 255, 255, 0.5)");
  });

  it("leaves a non-hex color unchanged", () => {
    expect(withAlpha("rgb(1, 2, 3)", 0.4)).toBe("rgb(1, 2, 3)");
  });
});
