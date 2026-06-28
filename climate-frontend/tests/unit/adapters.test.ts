import { describe, expect, it } from "vitest";
import {
  toEventEntry,
  toGreenhouseDetail,
  toGreenhouseSummary,
  toTelemetryRange,
  toTimeScale,
  toWireRegistration,
  toWireSetpointsPatch,
  wireEventEntry,
  wireGreenhouseDetail,
  wireGreenhouseSummary,
  wireGreenhouseRegistration,
  wireSetpointsPatch,
  wireTelemetryRange,
  wireTimeScale,
  type SetpointsPatch,
} from "../../src/api/schemas";
import { restFixture } from "../fixtures";

const parse = <T>(schema: { parse: (v: unknown) => T }, fixture: string): T =>
  schema.parse(restFixture(fixture));

describe("wire → view-model adapters", () => {
  it("maps a greenhouse summary to camelCase", () => {
    const vm = toGreenhouseSummary(parse(wireGreenhouseSummary, "greenhouse-summary.json"));
    expect(vm).toMatchObject({ id: "gh-a", displayName: "Greenhouse A", timeScale: 2 });
    expect(vm.climate.temperature).toBe(23.4);
    expect(vm.climate.humidity).toBe(58);
    expect(vm.climate.co2).toBe(820);
    expect(vm.climate.dli).toBe(12.6);
    expect(vm.climate.setpointTemperature).toBe(24);
  });

  it("maps a greenhouse detail incl. setpoints + zones", () => {
    const vm = toGreenhouseDetail(parse(wireGreenhouseDetail, "greenhouse-detail.json"));
    expect(vm.timeScale).toBeNull(); // absent on the wire → null
    expect(vm.setpoints.temperatureDayC).toBe(24);
    expect(vm.setpoints.zones[0]).toMatchObject({ zoneId: "bench-a", drainPeriodSecs: 300 });
  });

  it("maps a telemetry range, coercing timestamps to Date", () => {
    const vm = toTelemetryRange(parse(wireTelemetryRange, "telemetry-range.json"));
    expect(vm.from).toBeInstanceOf(Date);
    expect(vm.series[0].readings[0].ts).toBeInstanceOf(Date);
    expect(vm.actuators[0]).toMatchObject({ actuator: "roof_vents", zoneId: null });
  });

  it("maps an event entry", () => {
    const vm = toEventEntry(parse(wireEventEntry, "event.json"));
    expect(vm.greenhouseId).toBe("gh-a");
    expect(vm.ts).toBeInstanceOf(Date);
    expect(vm.kind).toBe("setpoint_edit");
  });

  it("maps a time scale", () => {
    const vm = toTimeScale(parse(wireTimeScale, "sim-time-scale.json"));
    expect(vm.updatedAt).toBeInstanceOf(Date);
    expect(typeof vm.scale).toBe("number");
  });
});

describe("view-model → wire encoders", () => {
  it("encodes a setpoints patch to snake_case and round-trips through the wire schema", () => {
    const patch: SetpointsPatch = {
      temperatureDayC: 25.5,
      zones: [
        {
          zoneId: "bench-a",
          moistureLowThreshold: 0.3,
          moistureHighThreshold: 0.6,
          drainPeriodSecs: 120,
          schedule: "06:00,18:00",
        },
      ],
    };
    const wire = toWireSetpointsPatch(patch);
    expect(wire).toMatchObject({ temperature_day_c: 25.5 });
    expect(wireSetpointsPatch.safeParse(wire).success).toBe(true);
  });

  it("encodes a registration to snake_case", () => {
    const wire = toWireRegistration({
      id: "gh-b",
      displayName: "Greenhouse B",
      controller: { restBaseUrl: "http://gh-b:8080", mqttTopicRoot: "gh/gh-b" },
    });
    expect(wire).toMatchObject({
      id: "gh-b",
      display_name: "Greenhouse B",
      controller: { rest_base_url: "http://gh-b:8080", mqtt_topic_root: "gh/gh-b" },
    });
    expect(wireGreenhouseRegistration.safeParse(wire).success).toBe(true);
  });
});
