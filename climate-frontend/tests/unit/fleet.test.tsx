import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import FleetOverview from "../../src/features/fleet/FleetOverview";
import { queryKeys } from "../../src/api/queries/keys";
import { makeClient, renderWithProviders, sampleSummary } from "../utils";

describe("FleetOverview", () => {
  it("shows the empty state with a register CTA when no greenhouses exist", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.fleet(), []);
    renderWithProviders(<FleetOverview />, { client });
    expect(screen.getByText("No greenhouses registered")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Register greenhouse" })).toBeInTheDocument();
  });

  it("renders a card per greenhouse with its connectivity", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.fleet(), [
      sampleSummary({ id: "gh-a", displayName: "Greenhouse A", status: "online" }),
      sampleSummary({ id: "gh-b", displayName: "Greenhouse B", status: "offline" }),
    ]);
    renderWithProviders(<FleetOverview />, { client });

    expect(screen.getByText("Greenhouse A")).toBeInTheDocument();
    expect(screen.getByText("Greenhouse B")).toBeInTheDocument();
    // "Online"/"Offline" appear both as a rollup caption and as a card badge.
    expect(screen.getAllByText("Online").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
  });
});
