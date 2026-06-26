import { describe, expect, it } from "vitest";
import { toFleetSparklines, wireFleetSparklines } from "../../src/api/schemas";
import { historyFor, indexFleetHistory } from "../../src/features/fleet/fleetHistory";
import { restFixture } from "../fixtures";

const fleetSparklines = () =>
  toFleetSparklines(wireFleetSparklines.parse(restFixture("fleet-sparklines.json")));

describe("toFleetSparklines", () => {
  it("maps the batched response to camelCase, coercing timestamps to Date", () => {
    const vm = fleetSparklines();
    expect(vm.metric).toBe("temperature");
    expect(vm.from).toBeInstanceOf(Date);
    expect(vm.series[0].greenhouseId).toBe("gh-a");
    expect(vm.series[0].readings[0]).toMatchObject({ value: 23.1 });
    expect(vm.series[0].readings[0].ts).toBeInstanceOf(Date);
  });
});

describe("indexFleetHistory / historyFor", () => {
  it("indexes readings by greenhouse id", () => {
    const index = indexFleetHistory(fleetSparklines());
    expect(index.get("gh-a")).toHaveLength(3);
    expect(historyFor(index, "gh-b")).toHaveLength(2);
  });

  it("returns a shared empty array for greenhouses with no history", () => {
    const index = indexFleetHistory(fleetSparklines());
    expect(historyFor(index, "gh-missing")).toEqual([]);
    expect(historyFor(index, "gh-x")).toBe(historyFor(index, "gh-y")); // stable reference
  });

  it("yields an empty index when there is no data yet", () => {
    expect(indexFleetHistory(undefined).size).toBe(0);
  });
});
