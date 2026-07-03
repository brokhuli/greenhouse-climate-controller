import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import FleetOverview from "../../src/features/fleet/FleetOverview";
import { queryKeys } from "../../src/api/queries/keys";
import type { Assignment, CropProfile } from "../../src/api/schemas";
import { makeClient, renderWithProviders, sampleSetpoints, sampleSummary } from "../utils";

const profile = (): CropProfile => ({
  id: "lettuce",
  name: "Lettuce",
  crop: "lettuce",
  stages: [{ stage: "vegetative", targets: sampleSetpoints({ zones: [] }) }],
});

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

  it("shows the assigned crop profile below the greenhouse name", () => {
    const client = makeClient();
    const assignment: Assignment = {
      greenhouseId: "gh-a",
      profileId: "lettuce",
      stage: "vegetative",
    };
    client.setQueryData(queryKeys.fleet(), [
      sampleSummary({ id: "gh-a", displayName: "Greenhouse A" }),
    ]);
    client.setQueryData(queryKeys.assignment("gh-a"), assignment);
    client.setQueryData(queryKeys.profile("lettuce"), profile());

    renderWithProviders(<FleetOverview />, { client });

    expect(screen.getByText("Greenhouse A")).toBeInTheDocument();
    expect(screen.getByText("Lettuce")).toBeInTheDocument();
  });

  it("offers the shared range options and reflects the selection", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.fleet(), [sampleSummary({ id: "gh-a" })]);
    renderWithProviders(<FleetOverview />, { client });

    for (const option of ["15m", "30m", "1h", "6h", "24h"]) {
      expect(screen.getByRole("radio", { name: option })).toBeInTheDocument();
    }
    // Defaults to 1h; selecting another option moves the checked state.
    expect(screen.getByRole("radio", { name: "1h" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("radio", { name: "15m" }));
    expect(screen.getByRole("radio", { name: "15m" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "1h" })).toHaveAttribute("aria-checked", "false");
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

  it("renders the temperature, humidity, CO₂, and DLI quadrant with their values", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.fleet(), [
      sampleSummary({
        id: "gh-a",
        displayName: "Greenhouse A",
        climate: { temperature: 23.4, humidity: 58, co2: 820, dli: 12.6, setpointTemperature: 24 },
      }),
    ]);
    renderWithProviders(<FleetOverview />, { client });

    expect(screen.getByText("Temperature")).toBeInTheDocument();
    expect(screen.getByText("Humidity")).toBeInTheDocument();
    expect(screen.getByText("CO₂")).toBeInTheDocument();
    expect(screen.getByText("DLI")).toBeInTheDocument();
    expect(screen.getByText("23.4")).toBeInTheDocument();
    expect(screen.getByText("58")).toBeInTheDocument();
    expect(screen.getByText("820")).toBeInTheDocument();
    expect(screen.getByText("12.6")).toBeInTheDocument();
    // The setpoint readout was removed from the tiles (data path undecided).
    expect(screen.queryByText("Setpoint")).not.toBeInTheDocument();
  });
});
