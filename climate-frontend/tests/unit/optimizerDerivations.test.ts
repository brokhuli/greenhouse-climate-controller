import { describe, expect, it } from "vitest";
import type { FleetOptimizerGreenhouse, SetpointDiff } from "../../src/api/schemas";
import {
  compareFleetTriage,
  formatDurationSecs,
  isNearBound,
  lastCycleAge,
  setpointDiffRows,
  sortEscalationsByTriage,
  toOptimizerCardState,
} from "../../src/features/optimizer/derivations";
import { optimizerActionError } from "../../src/features/optimizer/errors";
import { ApiError } from "../../src/api/client";
import { sampleEscalation, sampleOptimizerStatus, sampleSetpoints } from "../utils";

const entry = (overrides: Partial<FleetOptimizerGreenhouse> = {}): FleetOptimizerGreenhouse => ({
  greenhouseId: "gh-a",
  status: "applied",
  reasonCode: null,
  enabled: true,
  createdAt: new Date("2026-06-29T13:30:00.000Z"),
  ...overrides,
});

describe("toOptimizerCardState — precedence", () => {
  it("read-only wins when the service is globally paused, even with an entry", () => {
    expect(toOptimizerCardState(entry({ enabled: false }), false)).toEqual({ kind: "read-only" });
  });

  it("disabled when the greenhouse is paused (service enabled)", () => {
    expect(toOptimizerCardState(entry({ enabled: false }), true)).toEqual({ kind: "disabled" });
  });

  it("surfaces the outcome for an enabled greenhouse", () => {
    expect(
      toOptimizerCardState(entry({ status: "escalated", reasonCode: "low_confidence" }), true),
    ).toEqual({ kind: "outcome", status: "escalated", reasonCode: "low_confidence" });
  });

  it("no-plan when the greenhouse is absent from the summary", () => {
    expect(toOptimizerCardState(undefined, true)).toEqual({ kind: "no-plan" });
  });

  it("read-only still wins over an absent entry", () => {
    expect(toOptimizerCardState(undefined, false)).toEqual({ kind: "read-only" });
  });
});

describe("escalation triage ordering", () => {
  it("sorts persistent before transient, then oldest first", () => {
    const older = sampleEscalation({
      id: "a",
      reasonClass: "transient",
      createdAt: new Date("2026-06-29T10:00:00.000Z"),
    });
    const persistent = sampleEscalation({
      id: "b",
      reasonClass: "persistent",
      createdAt: new Date("2026-06-29T12:00:00.000Z"),
    });
    const newerTransient = sampleEscalation({
      id: "c",
      reasonClass: "transient",
      createdAt: new Date("2026-06-29T13:00:00.000Z"),
    });
    const ordered = sortEscalationsByTriage([newerTransient, older, persistent]).map((e) => e.id);
    expect(ordered).toEqual(["b", "a", "c"]);
  });

  it("compareFleetTriage derives class from the reason code", () => {
    // constraint_violation is persistent; low_confidence is transient.
    const persistent = entry({ status: "escalated", reasonCode: "constraint_violation" });
    const transient = entry({
      status: "escalated",
      reasonCode: "low_confidence",
      createdAt: new Date("2026-06-29T09:00:00.000Z"),
    });
    expect([transient, persistent].sort(compareFleetTriage)[0]).toBe(persistent);
  });
});

describe("setpointDiffRows", () => {
  const diff: SetpointDiff = {
    proposed: { temperatureDayC: 22.5, vpdTargetKpa: 1.38 },
    current: sampleSetpoints({ temperatureDayC: 24, vpdTargetKpa: 1.0 }),
    bounds: {
      temperature_day_c: { min: 18, max: 28 },
      vpd_target_kpa: { min: 0.6, max: 1.4 },
    },
  };

  it("emits one row per changed field with direction", () => {
    const rows = setpointDiffRows(diff);
    expect(rows.map((r) => r.field)).toEqual(["temperature_day_c", "vpd_target_kpa"]);
    expect(rows[0].direction).toBe("down"); // 24 → 22.5
    expect(rows[1].direction).toBe("up"); // 1.0 → 1.38
  });

  it("flags a proposed value near a crop-safe bound", () => {
    const rows = setpointDiffRows(diff);
    expect(rows[0].nearBound).toBe(false); // 22.5 mid-range
    expect(rows[1].nearBound).toBe(true); // 1.38 within 5% of max 1.4
  });

  it("omits fields the plan did not propose", () => {
    expect(setpointDiffRows({ ...diff, proposed: {} })).toEqual([]);
  });
});

describe("isNearBound", () => {
  it("is true at or within 5% of either bound, false mid-range", () => {
    expect(isNearBound(18, { min: 18, max: 28 })).toBe(true);
    expect(isNearBound(28, { min: 18, max: 28 })).toBe(true);
    expect(isNearBound(23, { min: 18, max: 28 })).toBe(false);
  });
});

describe("lastCycleAge / formatDurationSecs", () => {
  it("flags a cycle overdue past the cadence", () => {
    const status = sampleOptimizerStatus({
      lastSuccessfulCycleAt: new Date("2026-06-29T13:00:00.000Z"),
      cadenceSecs: 1800,
    });
    const soon = lastCycleAge(status, new Date("2026-06-29T13:20:00.000Z"));
    expect(soon.stale).toBe(false);
    const late = lastCycleAge(status, new Date("2026-06-29T14:00:00.000Z"));
    expect(late.stale).toBe(true);
  });

  it("reports no age before the first cycle (cold start)", () => {
    expect(lastCycleAge(sampleOptimizerStatus({ lastSuccessfulCycleAt: null })).ageSecs).toBeNull();
  });

  it("formats compact durations", () => {
    expect(formatDurationSecs(45)).toBe("45s");
    expect(formatDurationSecs(90)).toBe("1m 30s");
    expect(formatDurationSecs(1800)).toBe("30m");
    expect(formatDurationSecs(5400)).toBe("1h 30m");
  });
});

describe("optimizerActionError", () => {
  it("maps 409 to the paused/in-flight message", () => {
    const error = new ApiError("client", "conflict", { status: 409 });
    expect(optimizerActionError(error, "fallback")).toMatch(/paused or already planning/);
  });

  it("maps 400 to the allowlist message", () => {
    const error = new ApiError("client", "bad", { status: 400 });
    expect(optimizerActionError(error, "fallback")).toMatch(/allowlist/);
  });

  it("falls back to the error message otherwise", () => {
    expect(optimizerActionError(new Error("boom"), "fallback")).toBe("boom");
  });
});
