import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../src/api/queries/keys";
import type {
  DriftFrame,
  EventEntry,
  EventFrame,
  GreenhouseSummary,
  StatusFrame,
  TelemetryFrame,
} from "../../src/api/schemas";
import {
  applyDriftFrame,
  applyEventFrame,
  applyStatusFrame,
  applyStatusToSummary,
  applyTelemetryToSummary,
  eventFrameToEntry,
  eventMatchesScope,
} from "../../src/lib/livePatch";
import { sampleSummary } from "../utils";

const base = {
  schema_version: 1,
  greenhouse_id: "gh-a",
  zone_id: null,
  ts: "2026-06-24T14:03:00.000Z",
} as const;

const statusFrame: StatusFrame = { ...base, type: "status", status: "degraded", time_scale: 2 };
const driftFrame: DriftFrame = { ...base, type: "drift", drift: true };
const eventFrame: EventFrame = {
  ...base,
  type: "event",
  kind: "fault",
  severity: "info",
  message: "sensor glitch",
  source: "sim",
};
const telemetryFrame: TelemetryFrame = {
  ...base,
  type: "telemetry",
  readings: [
    { metric: "temperature", value: 25, unit: "°C" },
    { metric: "humidity", value: 61, unit: "%RH" },
  ],
};

describe("pure frame transforms", () => {
  it("applies status (connectivity + time-scale) and is referentially stable when unchanged", () => {
    const summary = sampleSummary({ status: "online", timeScale: 1 });
    const next = applyStatusToSummary(summary, statusFrame);
    expect(next.status).toBe("degraded");
    expect(next.timeScale).toBe(2);
    expect(next).not.toBe(summary);
    expect(applyStatusToSummary(next, statusFrame)).toBe(next);
  });

  it("updates the card temperature + humidity from house-level readings and ignores zone readings", () => {
    const summary = sampleSummary({
      climate: { temperature: 20, humidity: 50, setpointTemperature: 24 },
    });
    const next = applyTelemetryToSummary(summary, telemetryFrame);
    expect(next.climate.temperature).toBe(25);
    expect(next.climate.humidity).toBe(61);
    const zoneFrame: TelemetryFrame = { ...telemetryFrame, zone_id: "bench-a" };
    expect(applyTelemetryToSummary(summary, zoneFrame)).toBe(summary);
  });

  it("matches events against a filter scope", () => {
    const entry = eventFrameToEntry(eventFrame);
    expect(eventMatchesScope(entry, {})).toBe(true);
    expect(eventMatchesScope(entry, { kind: "fault" })).toBe(true);
    expect(eventMatchesScope(entry, { greenhouseId: "gh-b" })).toBe(false);
    expect(eventMatchesScope(entry, { severity: "critical" })).toBe(false);
  });
});

describe("cache patches", () => {
  it("patches a status frame into the fleet summary", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.fleet(), [sampleSummary({ status: "online" })]);
    applyStatusFrame(client, statusFrame);
    const fleet = client.getQueryData<GreenhouseSummary[]>(queryKeys.fleet());
    expect(fleet?.[0].status).toBe("degraded");
  });

  it("patches a drift frame into the fleet summary", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.fleet(), [sampleSummary({ drift: false })]);
    applyDriftFrame(client, driftFrame);
    expect(client.getQueryData<GreenhouseSummary[]>(queryKeys.fleet())?.[0].drift).toBe(true);
  });

  it("prepends an event only to activity queries whose scope it matches", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.events({}), []);
    client.setQueryData(queryKeys.events({ greenhouseId: "gh-b" }), []);
    client.setQueryData(queryKeys.events({ severity: "critical" }), []);

    applyEventFrame(client, eventFrame);

    expect(client.getQueryData<EventEntry[]>(queryKeys.events({}))).toHaveLength(1);
    expect(
      client.getQueryData<EventEntry[]>(queryKeys.events({ greenhouseId: "gh-b" })),
    ).toHaveLength(0);
    expect(
      client.getQueryData<EventEntry[]>(queryKeys.events({ severity: "critical" })),
    ).toHaveLength(0);
  });
});
