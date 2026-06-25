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
    // "Online" surfaces as a card connectivity badge; "Offline" as both a badge and a rollup tile.
    expect(screen.getAllByText("Online").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
  });

  it("renders the fleet summary bar with its labeled rollup tiles", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.fleet(), [
      sampleSummary({ id: "gh-a", status: "online" }),
      sampleSummary({ id: "gh-b", status: "degraded", drift: true }),
    ]);
    renderWithProviders(<FleetOverview />, { client });

    for (const label of ["Total Greenhouses", "Healthy", "Attention Needed", "Drift Detected"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("renders temperature and humidity tiles, each with a Setpoint readout", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.fleet(), [
      sampleSummary({
        id: "gh-a",
        displayName: "Greenhouse A",
        climate: { temperature: 23.4, humidity: 58, setpointTemperature: 24 },
      }),
    ]);
    renderWithProviders(<FleetOverview />, { client });

    expect(screen.getByText("Temperature")).toBeInTheDocument();
    expect(screen.getByText("Humidity")).toBeInTheDocument();
    expect(screen.getByText("23.4")).toBeInTheDocument();
    expect(screen.getByText("58")).toBeInTheDocument();
    // Both tiles carry the "Setpoint" sub-line (temperature populated, humidity placeholder).
    expect(screen.getAllByText("Setpoint").length).toBe(2);
  });
});
