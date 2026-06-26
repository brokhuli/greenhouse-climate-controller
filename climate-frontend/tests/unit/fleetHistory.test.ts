import { describe, expect, it } from "vitest";
import { toFleetSparklines, wireFleetSparklines } from "../../src/api/schemas";
import {
  historyFor,
  historyForGreenhouse,
  indexFleetHistory,
} from "../../src/features/fleet/fleetHistory";
import { restFixture } from "../fixtures";

const fleetSparklines = () =>
  toFleetSparklines(wireFleetSparklines.parse(restFixture("fleet-sparklines.json")));

describe("toFleetSparklines", () => {
  it("maps the batched response to camelCase, coercing timestamps to Date", () => {
    const vm = fleetSparklines();
    expect(vm.metrics).toEqual(["temperature", "humidity", "co2", "par"]);
    expect(vm.from).toBeInstanceOf(Date);
    expect(vm.series[0].greenhouseId).toBe("gh-a");
    expect(vm.series[0].metrics[0].metric).toBe("temperature");
    expect(vm.series[0].metrics[0].readings[0]).toMatchObject({ value: 23.1 });
    expect(vm.series[0].metrics[0].readings[0].ts).toBeInstanceOf(Date);
  });
});

describe("indexFleetHistory / historyFor", () => {
  it("indexes readings by greenhouse id, then metric", () => {
    const index = indexFleetHistory(fleetSparklines());
    expect(historyFor(index, "gh-a", "temperature")).toHaveLength(3);
    expect(historyFor(index, "gh-a", "humidity")).toHaveLength(3);
    expect(historyFor(index, "gh-a", "co2")).toHaveLength(3);
    expect(historyFor(index, "gh-b", "temperature")).toHaveLength(2);
    // gh-b carries no co2 series in the fixture.
    expect(historyFor(index, "gh-b", "co2")).toHaveLength(0);
  });

  it("exposes a greenhouse's whole per-metric map for the card", () => {
    const index = indexFleetHistory(fleetSparklines());
    const ghA = historyForGreenhouse(index, "gh-a");
    expect([...ghA.keys()]).toEqual(["temperature", "humidity", "co2", "par"]);
    expect(ghA.get("par")).toHaveLength(3);
  });

  it("returns shared empty fallbacks for greenhouses/metrics with no history", () => {
    const index = indexFleetHistory(fleetSparklines());
    expect(historyFor(index, "gh-missing", "temperature")).toEqual([]);
    expect(historyFor(index, "gh-x", "temperature")).toBe(historyFor(index, "gh-y", "humidity")); // stable reference
    expect(historyForGreenhouse(index, "gh-x")).toBe(historyForGreenhouse(index, "gh-y")); // stable reference
  });

  it("yields an empty index when there is no data yet", () => {
    expect(indexFleetHistory(undefined).size).toBe(0);
  });
});
