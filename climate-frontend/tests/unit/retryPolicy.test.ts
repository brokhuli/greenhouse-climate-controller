import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/client";
import { queryRetryDelay, shouldRetryQuery } from "../../src/api/retryPolicy";

describe("shouldRetryQuery", () => {
  const networkError = new ApiError("network", "could not reach the platform API");

  it("retries a transient network failure exactly once", () => {
    expect(shouldRetryQuery(0, networkError)).toBe(true);
    expect(shouldRetryQuery(1, networkError)).toBe(false);
    expect(shouldRetryQuery(2, networkError)).toBe(false);
  });

  it("never retries server overload / dependency / deterministic errors", () => {
    for (const kind of [
      "server",
      "unavailable",
      "client",
      "not_found",
      "validation",
      "parse",
    ] as const) {
      expect(shouldRetryQuery(0, new ApiError(kind, "nope", { status: 503 }))).toBe(false);
    }
  });

  it("never retries a non-ApiError value", () => {
    expect(shouldRetryQuery(0, new Error("plain"))).toBe(false);
    expect(shouldRetryQuery(0, undefined)).toBe(false);
    expect(shouldRetryQuery(0, "boom")).toBe(false);
  });
});

describe("queryRetryDelay", () => {
  it("grows exponentially and stays within the jittered bounds, capped at 30s", () => {
    for (const attempt of [0, 1, 2, 5, 10, 20]) {
      const base = Math.min(1000 * 2 ** attempt, 30_000);
      const delay = queryRetryDelay(attempt);
      expect(delay).toBeGreaterThanOrEqual(base);
      expect(delay).toBeLessThan(base + 250);
    }
  });
});
