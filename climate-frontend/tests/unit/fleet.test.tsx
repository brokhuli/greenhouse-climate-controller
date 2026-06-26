import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import FleetOverview from "../../src/features/fleet/FleetOverview";
import { queryKeys } from "../../src/api/queries/keys";
import { makeClient, renderWithProviders, sampleSparklines, sampleSummary } from "../utils";

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

  it("renders a row per card metric with its latest seeded value", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.fleet(), [
      sampleSummary({ id: "gh-a", displayName: "Greenhouse A", status: "online" }),
    ]);
    // The displayed value is the latest point of each metric's merged series, seeded from the
    // batched sparkline cache (no longer summary.climate).
    client.setQueryData(
      queryKeys.fleetSparklines("1h"),
      sampleSparklines([
        { greenhouseId: "gh-a", values: { temperature: 23.4, humidity: 58, co2: 842, par: 320 } },
      ]),
    );
    // Pin the window via the URL (it outranks any localStorage left by a prior test) so the seeded
    // ["fleet-sparklines", "1h"] cache entry is the one the card reads.
    renderWithProviders(<FleetOverview />, { client, route: "/?window=1h" });

    for (const label of ["Temperature", "Humidity", "CO₂", "PAR"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("23.4")).toBeInTheDocument();
    expect(screen.getByText("58")).toBeInTheDocument();
    expect(screen.getByText("842")).toBeInTheDocument();
    expect(screen.getByText("320")).toBeInTheDocument();
  });
});
