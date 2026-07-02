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
