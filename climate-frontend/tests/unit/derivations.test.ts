import { describe, expect, it } from "vitest";
import type { Connectivity, EventEntry, GreenhouseSummary } from "../../src/api/schemas";
import {
  activeFaultCount,
  rangeTierSelection,
  readingVsSetpointDelta,
  statusRollup,
} from "../../src/lib/derivations";

const summary = (status: Connectivity, drift = false): GreenhouseSummary => ({
  id: "x",
  displayName: "x",
  crop: null,
  status,
  drift,
  timeScale: null,
  climate: {},
});

const event = (kind: EventEntry["kind"]): EventEntry => ({
  greenhouseId: "x",
  ts: new Date("2026-06-24T00:00:00.000Z"),
  kind,
  severity: "warning",
  message: "x",
});

describe("readingVsSetpointDelta", () => {
  it("computes the signed delta and direction", () => {
    expect(readingVsSetpointDelta(23.4, 24)).toMatchObject({ direction: "below" });
    expect(readingVsSetpointDelta(26, 24)).toMatchObject({ direction: "above" });
    expect(readingVsSetpointDelta(25, 25)).toEqual({ delta: 0, direction: "equal" });
  });

  it("returns unknown when either value is missing", () => {
    expect(readingVsSetpointDelta(null, 24)).toEqual({ delta: null, direction: "unknown" });
    expect(readingVsSetpointDelta(23, undefined)).toEqual({ delta: null, direction: "unknown" });
  });
});

describe("statusRollup", () => {
  it("counts connectivity and drift across the fleet", () => {
    const rollup = statusRollup([
      summary("online"),
      summary("online"),
      summary("degraded", true),
      summary("offline"),
    ]);
    expect(rollup).toMatchObject({ total: 4, online: 2, degraded: 1, offline: 1, drift: 1 });
  });
});

describe("activeFaultCount", () => {
  it("counts only fault-kind events in the feed", () => {
    expect(activeFaultCount([event("fault"), event("setpoint_edit"), event("fault")])).toBe(2);
  });

  it("is zero for an empty or fault-free feed", () => {
    expect(activeFaultCount([])).toBe(0);
    expect(activeFaultCount([event("drift"), event("interlock")])).toBe(0);
  });
});

describe("rangeTierSelection", () => {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;

  it("uses raw telemetry within the threshold", () => {
    expect(rangeTierSelection(hour)).toEqual({ tier: "raw" });
    expect(rangeTierSelection(day)).toEqual({ tier: "raw" });
  });

  it("aggregates longer ranges with a bounded bucket interval", () => {
    expect(rangeTierSelection(2 * day)).toEqual({ tier: "aggregate", interval: "15m" });
    expect(rangeTierSelection(7 * day)).toEqual({ tier: "aggregate", interval: "1h" });
  });
});
