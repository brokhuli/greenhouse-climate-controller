import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  driftFrame,
  eventFrame,
  statusFrame,
  telemetryFrame,
  wireAnalyticsResponse,
  wireEventEntry,
  wireFleetTimeScaleResult,
  wireGreenhouseDetail,
  wireGreenhouseRegistration,
  wireGreenhouseSummary,
  wireSetpoints,
  wireSetpointsPatch,
  wireTelemetryRange,
  wireTimeScale,
  wireTimeScalePatch,
} from "../../src/api/schemas";
import { restFixture, wsFixture } from "../fixtures";

/**
 * The SPA's wire schemas mirror `contracts/frontend-{rest,ws}/` field-for-field, so every positive
 * contract fixture must parse and every `*.bad-*` counter-example must fail — the same pass/fail
 * matrix the contract harness enforces.
 */

type Case = { fixture: string; schema: z.ZodTypeAny; expect: "pass" | "fail" };

const expectMatch = (schema: z.ZodTypeAny, value: unknown, outcome: "pass" | "fail") => {
  const result = schema.safeParse(value);
  expect(result.success, JSON.stringify(result.success ? null : result.error?.issues)).toBe(
    outcome === "pass",
  );
};

describe("REST wire schemas vs contract fixtures", () => {
  const cases: Case[] = [
    { fixture: "greenhouse-summary.json", schema: wireGreenhouseSummary, expect: "pass" },
    { fixture: "greenhouse-detail.json", schema: wireGreenhouseDetail, expect: "pass" },
    { fixture: "registration.json", schema: wireGreenhouseRegistration, expect: "pass" },
    { fixture: "setpoints.patch.json", schema: wireSetpointsPatch, expect: "pass" },
    { fixture: "setpoints.bad-range.json", schema: wireSetpoints, expect: "fail" },
    { fixture: "telemetry-range.json", schema: wireTelemetryRange, expect: "pass" },
    { fixture: "analytics.json", schema: wireAnalyticsResponse, expect: "pass" },
    { fixture: "event.json", schema: wireEventEntry, expect: "pass" },
    { fixture: "event.bad-kind.json", schema: wireEventEntry, expect: "fail" },
    { fixture: "sim-time-scale.patch.json", schema: wireTimeScalePatch, expect: "pass" },
    { fixture: "sim-time-scale.json", schema: wireTimeScale, expect: "pass" },
    { fixture: "sim-time-scale.bad-range.json", schema: wireTimeScalePatch, expect: "fail" },
    { fixture: "sim-time-scale-all.json", schema: wireFleetTimeScaleResult, expect: "pass" },
  ];

  it.each(cases)("$fixture → $expect", ({ fixture, schema, expect: outcome }) => {
    expectMatch(schema, restFixture(fixture), outcome);
  });
});

describe("WebSocket frame schemas vs contract fixtures", () => {
  const cases: Case[] = [
    { fixture: "telemetry.json", schema: telemetryFrame, expect: "pass" },
    { fixture: "status.json", schema: statusFrame, expect: "pass" },
    { fixture: "drift.json", schema: driftFrame, expect: "pass" },
    { fixture: "event.json", schema: eventFrame, expect: "pass" },
    { fixture: "telemetry.bad-unit.json", schema: telemetryFrame, expect: "fail" },
    { fixture: "telemetry.bad-extra.json", schema: telemetryFrame, expect: "fail" },
    { fixture: "event.bad-kind.json", schema: eventFrame, expect: "fail" },
  ];

  it.each(cases)("$fixture → $expect", ({ fixture, schema, expect: outcome }) => {
    expectMatch(schema, wsFixture(fixture), outcome);
  });
});
