import { describe, expect, it } from "vitest";
import { LeafyGreen, Sprout } from "lucide-react";
import {
  climateTargetRows,
  cropIcon,
  fmt,
  stageSummary,
} from "../../src/features/profiles/stageTargets";
import type { Setpoints, StageBounds } from "../../src/api/schemas";

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
  zones: [],
});

describe("fmt", () => {
  it("keeps at most two decimals and strips trailing zeros", () => {
    expect(fmt(900)).toBe("900");
    expect(fmt(22.5)).toBe("22.5");
    expect(fmt(1.05)).toBe("1.05");
  });
});

describe("climateTargetRows", () => {
  it("returns a row per scalar metric with its value and unit", () => {
    const rows = climateTargetRows(targets());
    const day = rows.find((row) => row.key === "temperatureDayC")!;
    expect(day.value).toBe("24");
    expect(day.unit).toBe("°C");
    const co2 = rows.find((row) => row.key === "co2TargetPpm")!;
    expect(co2.value).toBe("900");
    expect(co2.unit).toBe("ppm");
    // No envelope → no crop-safe range.
    expect(day.range).toBeNull();
  });

  it("includes the crop-safe range when the stage carries an envelope", () => {
    const bounds: StageBounds = { temperatureDayC: { min: 21, max: 27 } };
    const rows = climateTargetRows(targets(), bounds);
    const day = rows.find((row) => row.key === "temperatureDayC")!;
    expect(day.range).toBe("21–27");
  });
});

describe("stageSummary", () => {
  it("condenses the headline climate targets", () => {
    const byLabel = Object.fromEntries(stageSummary(targets()).map((c) => [c.label, c.value]));
    expect(byLabel["Day/Night"]).toBe("24/18 °C");
    expect(byLabel["RH"]).toBe("55–80 %");
    expect(byLabel["CO₂"]).toBe("900 ppm");
    expect(byLabel["DLI"]).toBe("17 mol");
  });
});

describe("cropIcon", () => {
  it("maps a known crop to its botanical icon", () => {
    expect(cropIcon("Lettuce")).toBe(LeafyGreen);
    expect(cropIcon("mixed greens")).toBe(LeafyGreen);
  });

  it("falls back to a sprout for unmatched crops", () => {
    expect(cropIcon("tomato")).toBe(Sprout);
    expect(cropIcon("")).toBe(Sprout);
  });
});
