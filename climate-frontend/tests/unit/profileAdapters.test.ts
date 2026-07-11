import { describe, expect, it } from "vitest";
import {
  toAssignment,
  toCropProfile,
  toWireAssignmentInput,
  toWireCropProfile,
  toWireCropProfilePatch,
  toWireSetpoints,
  wireAssignment,
  wireCropProfile,
  wireSetpoints,
  type CropProfile,
  type Setpoints,
} from "../../src/api/schemas";

const targets = (): Setpoints => ({
  temperatureDayC: 24,
  temperatureNightC: 18,
  dayStart: "06:00",
  dayEnd: "20:00",
  humidityLowPct: 55,
  humidityHighPct: 80,
  humidityDeadbandPct: 5,
  co2TargetPpm: 900,
  co2VentInterlockThresholdPct: 20,
  vpdTargetKpa: 1,
  dliTargetMol: 17,
  zones: [
    {
      zoneId: "bench-a",
      moistureLowThreshold: 0.3,
      moistureHighThreshold: 0.6,
      drainPeriodSecs: 600,
      schedule: "06:00,14:00",
    },
  ],
});

const profile = (): CropProfile => ({
  id: "lettuce",
  name: "Lettuce",
  crop: "lettuce",
  stages: [{ stage: "vegetative", targets: targets() }],
});

describe("crop-profile adapters", () => {
  it("maps a wire profile (snake_case) to the camelCase view model", () => {
    const wire = {
      id: "lettuce",
      name: "Lettuce",
      crop: "lettuce",
      stages: [{ stage: "vegetative", targets: toWireSetpoints(targets()) }],
    };
    const vm = toCropProfile(wireCropProfile.parse(wire));
    expect(vm.stages[0].targets.temperatureDayC).toBe(24);
    expect(vm.stages[0].targets.zones[0]).toMatchObject({
      zoneId: "bench-a",
      drainPeriodSecs: 600,
    });
  });

  it("encodes a full profile that round-trips through the wire schema", () => {
    const wire = toWireCropProfile(profile());
    expect(wireCropProfile.safeParse(wire).success).toBe(true);
    expect(wire.stages[0].targets).toMatchObject({ temperature_day_c: 24, co2_target_ppm: 900 });
  });

  it("encodes a patch without the immutable id", () => {
    const patch = toWireCropProfilePatch(profile());
    expect(patch).not.toHaveProperty("id");
    expect(patch.stages[0].targets).toMatchObject({ vpd_target_kpa: 1 });
  });

  it("round-trips a stage's crop-safe envelope through the wire schema", () => {
    const withBounds = profile();
    withBounds.stages[0].bounds = {
      temperatureDayC: { min: 21, max: 26 },
      co2TargetPpm: { min: 800, max: 1000 },
    };
    const wire = toWireCropProfile(withBounds);
    expect(wireCropProfile.safeParse(wire).success).toBe(true);
    expect(wire.stages[0].bounds).toEqual({
      temperature_day_c: { min: 21, max: 26 },
      co2_target_ppm: { min: 800, max: 1000 },
    });

    const back = toCropProfile(wireCropProfile.parse(wire));
    expect(back.stages[0].bounds).toEqual(withBounds.stages[0].bounds);
  });

  it("round-trips a stage's per-zone crop-safe envelope through the wire schema", () => {
    const withZoneBounds = profile();
    withZoneBounds.stages[0].bounds = {
      temperatureDayC: { min: 21, max: 26 },
      zones: {
        moistureLowThreshold: { min: 0.2, max: 0.4 },
        drainPeriodSecs: { min: 400, max: 800 },
      },
    };
    const wire = toWireCropProfile(withZoneBounds);
    expect(wireCropProfile.safeParse(wire).success).toBe(true);
    expect(wire.stages[0].bounds?.zones).toEqual({
      moisture_low_threshold: { min: 0.2, max: 0.4 },
      drain_period_secs: { min: 400, max: 800 },
    });

    const back = toCropProfile(wireCropProfile.parse(wire));
    expect(back.stages[0].bounds).toEqual(withZoneBounds.stages[0].bounds);
  });

  it("omits bounds entirely when a stage defines none", () => {
    const wire = toWireCropProfile(profile());
    expect(wire.stages[0]).not.toHaveProperty("bounds");
    expect(toCropProfile(wireCropProfile.parse(wire)).stages[0].bounds).toBeUndefined();
  });

  it("encodes full setpoints that round-trip through wireSetpoints", () => {
    expect(wireSetpoints.safeParse(toWireSetpoints(targets())).success).toBe(true);
  });

  it("maps an assignment and encodes an assignment input", () => {
    const vm = toAssignment(
      wireAssignment.parse({ greenhouse_id: "gh-a", profile_id: "lettuce", stage: "vegetative" }),
    );
    expect(vm).toEqual({ greenhouseId: "gh-a", profileId: "lettuce", stage: "vegetative" });
    expect(toWireAssignmentInput({ profileId: "lettuce", stage: "vegetative" })).toEqual({
      profile_id: "lettuce",
      stage: "vegetative",
    });
  });
});
