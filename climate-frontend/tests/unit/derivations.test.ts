import { describe, expect, it } from "vitest";
import type { Connectivity, EventEntry, GreenhouseSummary } from "../../src/api/schemas";
import {
  activeTemperatureSetpoint,
  activeFaultCount,
  formatLastWatered,
  formatSchedule,
  formatZoneLabel,
  moistureScalePosition,
  rangeTierSelection,
  readingVsSetpointDelta,
  statusRollup,
  zoneMoistureStatus,
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

const setpoints = {
  temperatureDayC: 24,
  temperatureNightC: 18,
  dayStart: "06:00",
  dayEnd: "20:00",
  humidityLowPct: 50,
  humidityHighPct: 85,
  humidityDeadbandPct: 5,
  co2TargetPpm: 1000,
  co2VentInterlockThresholdPct: 15,
  vpdTargetKpa: 1,
  dliTargetMol: 20,
  zones: [],
};

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

describe("activeTemperatureSetpoint", () => {
  it("resolves the day setpoint inside the configured UTC day window", () => {
    expect(activeTemperatureSetpoint(setpoints, new Date("2026-01-01T19:00:00.000Z"))).toEqual({
      label: "Day",
      value: 24,
    });
  });

  it("resolves the night setpoint outside the configured UTC day window", () => {
    expect(activeTemperatureSetpoint(setpoints, new Date("2026-01-01T21:00:00.000Z"))).toEqual({
      label: "Night",
      value: 18,
    });
  });

  it("supports day windows that wrap around midnight", () => {
    const wrapped = { ...setpoints, dayStart: "20:00", dayEnd: "06:00" };
    expect(activeTemperatureSetpoint(wrapped, new Date("2026-01-01T23:00:00.000Z"))).toEqual({
      label: "Day",
      value: 24,
    });
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

describe("zoneMoistureStatus", () => {
  const band = { lowThreshold: 0.3, highThreshold: 0.5 };

  it("reads a healthy in-band zone as OK", () => {
    expect(
      zoneMoistureStatus({ ...band, moistureVwc: 0.41, irrigating: false, faulted: false }),
    ).toMatchObject({ kind: "ok", label: "OK" });
  });

  it("reads below the low threshold as Dry", () => {
    expect(
      zoneMoistureStatus({ ...band, moistureVwc: 0.28, irrigating: false, faulted: false }),
    ).toMatchObject({ kind: "dry", label: "Dry" });
  });

  it("prefers Watering over Dry while the valve is open", () => {
    expect(
      zoneMoistureStatus({ ...band, moistureVwc: 0.28, irrigating: true, faulted: false }),
    ).toMatchObject({ kind: "watering", label: "Watering" });
  });

  it("prefers Fault over every other state", () => {
    expect(
      zoneMoistureStatus({ ...band, moistureVwc: 0.28, irrigating: true, faulted: true }),
    ).toMatchObject({ kind: "fault", label: "Fault" });
  });

  it("reads a missing reading as No data", () => {
    expect(
      zoneMoistureStatus({ ...band, moistureVwc: null, irrigating: false, faulted: false }),
    ).toMatchObject({ kind: "unknown", label: "No data" });
  });
});

describe("moistureScalePosition", () => {
  it("maps a reading to its own position on the 0–1 scale", () => {
    expect(moistureScalePosition(0.41)).toBe(0.41);
  });

  it("clamps readings outside 0–1 to the ends", () => {
    expect(moistureScalePosition(-0.1)).toBe(0);
    expect(moistureScalePosition(1.4)).toBe(1);
  });

  it("returns null with no reading", () => {
    expect(moistureScalePosition(null)).toBeNull();
  });
});

describe("formatLastWatered", () => {
  const now = new Date("2026-06-29T15:00:00.000Z");

  it("labels a same-day cycle as Today", () => {
    const ts = new Date("2026-06-29T08:00:00.000Z");
    expect(formatLastWatered(ts, now)).toBe(
      `Today, ${ts.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      })}`,
    );
  });

  it("labels an earlier day with its date", () => {
    const ts = new Date("2026-06-24T08:00:00.000Z");
    const result = formatLastWatered(ts, now);
    expect(result).toContain(ts.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    expect(result).not.toContain("Today");
  });

  it("reads a never-cycled zone as Never", () => {
    expect(formatLastWatered(null, now)).toBe("Never");
  });
});

describe("formatZoneLabel", () => {
  it("title-cases a kebab slug", () => {
    expect(formatZoneLabel("bench-a")).toBe("Bench A");
    expect(formatZoneLabel("propagation-zone")).toBe("Propagation Zone");
  });
});

describe("formatSchedule", () => {
  it("renders comma-separated times with comma-space separators", () => {
    expect(formatSchedule("06:00,14:00")).toBe("06:00, 14:00");
    expect(formatSchedule("06:00")).toBe("06:00");
  });
});
