import { describe, expect, it } from "vitest";
import {
  FLEET_POLL_BASE_MS,
  fleetPollIntervalMs,
  fleetStaleNotice,
  isStreamDegraded,
} from "../../src/api/queries/fleet";

const MIN = 60 * 1000;

describe("fleetPollIntervalMs", () => {
  it("escalates 60s → 2m → 5m as consecutive failures mount", () => {
    expect(fleetPollIntervalMs({ streamDegraded: false, consecutiveFailures: 0 })).toBe(
      FLEET_POLL_BASE_MS,
    );
    expect(fleetPollIntervalMs({ streamDegraded: false, consecutiveFailures: 0 })).toBe(1 * MIN);
    expect(fleetPollIntervalMs({ streamDegraded: false, consecutiveFailures: 1 })).toBe(2 * MIN);
    expect(fleetPollIntervalMs({ streamDegraded: false, consecutiveFailures: 2 })).toBe(5 * MIN);
    expect(fleetPollIntervalMs({ streamDegraded: false, consecutiveFailures: 7 })).toBe(5 * MIN);
  });

  it("floors a healthy poll at 2m while the stream is degraded (slow fallback, never disabled)", () => {
    expect(fleetPollIntervalMs({ streamDegraded: true, consecutiveFailures: 0 })).toBe(2 * MIN);
    expect(fleetPollIntervalMs({ streamDegraded: true, consecutiveFailures: 1 })).toBe(2 * MIN);
    // A harder backoff already above the floor is left intact.
    expect(fleetPollIntervalMs({ streamDegraded: true, consecutiveFailures: 2 })).toBe(5 * MIN);
  });
});

describe("isStreamDegraded", () => {
  it("treats reconnecting/closed as degraded but not the cold-start handshake", () => {
    expect(isStreamDegraded("reconnecting")).toBe(true);
    expect(isStreamDegraded("closed")).toBe(true);
    expect(isStreamDegraded("connecting")).toBe(false);
    expect(isStreamDegraded("open")).toBe(false);
  });
});

describe("fleetStaleNotice", () => {
  it("prefers the fetch-error message, then the degraded-stream message, else null", () => {
    expect(fleetStaleNotice(true, true)).toMatch(/showing the last known data/);
    expect(fleetStaleNotice(false, true)).toMatch(/showing the last known data/);
    expect(fleetStaleNotice(true, false)).toMatch(/Live stream degraded/);
    expect(fleetStaleNotice(false, false)).toBeNull();
  });
});
