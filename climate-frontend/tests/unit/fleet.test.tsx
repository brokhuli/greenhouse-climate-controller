import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import FleetOverview from "../../src/features/fleet/FleetOverview";
import { queryKeys } from "../../src/api/queries/keys";
import type { WsConnectionState } from "../../src/api/ws";
import type { Assignment, CropProfile, FleetSparklines } from "../../src/api/schemas";
import { makeClient, renderWithProviders, sampleSetpoints, sampleSummary } from "../utils";

// Drive `useStream` directly so tests can put the live stream into a degraded state without a real
// socket; default to a healthy "open" so the other cases are unaffected.
vi.mock("../../src/app/stream-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/stream-context")>();
  return {
    ...actual,
    useStream: vi.fn(() => ({ connectionState: "open", subscribeTelemetry: () => () => {} })),
  };
});
import { useStream } from "../../src/app/stream-context";

const mockedUseStream = vi.mocked(useStream);
const setStream = (connectionState: WsConnectionState) =>
  mockedUseStream.mockReturnValue({ connectionState, subscribeTelemetry: () => () => {} });

/** Seed the sparklines cache so the poll query resolves offline (isError stays false). */
const seedSparklines = (client: ReturnType<typeof makeClient>) => {
  const sparklines: FleetSparklines = {
    from: new Date("2026-06-29T00:00:00.000Z"),
    to: new Date("2026-06-29T01:00:00.000Z"),
    metric: "temperature",
    series: [],
  };
  client.setQueryData(queryKeys.fleetSparklines("1h"), sparklines);
};

beforeEach(() => setStream("open"));

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

  it("highlights the shared fleet speed even when an offline greenhouse lags behind", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.fleet(), [
      sampleSummary({ id: "gh-a", status: "online", timeScale: 8 }),
      sampleSummary({ id: "gh-b", status: "online", timeScale: 8 }),
      // Offline: the fan-out skipped it, so it kept its stale 1× — it must not blank the knob.
      sampleSummary({ id: "gh-c", status: "offline", timeScale: 1 }),
    ]);
    renderWithProviders(<FleetOverview />, { client });

    expect(screen.getByRole("radio", { name: "8×" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "1×" })).toHaveAttribute("aria-checked", "false");
  });

  it("highlights no fleet speed when the reachable greenhouses genuinely disagree", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.fleet(), [
      sampleSummary({ id: "gh-a", status: "online", timeScale: 8 }),
      sampleSummary({ id: "gh-b", status: "online", timeScale: 2 }),
    ]);
    renderWithProviders(<FleetOverview />, { client });

    for (const option of ["0.5×", "1×", "2×", "4×", "8×"]) {
      expect(screen.getByRole("radio", { name: option })).toHaveAttribute("aria-checked", "false");
    }
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
        climate: { temperature: 23.4, humidity: 58, co2: 820, dli: 12.6 },
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

  it("flags stale charts when the live stream is degraded, while still rendering cards", () => {
    setStream("reconnecting");
    const client = makeClient();
    client.setQueryData(queryKeys.fleet(), [
      sampleSummary({ id: "gh-a", displayName: "Greenhouse A" }),
    ]);
    seedSparklines(client);
    renderWithProviders(<FleetOverview />, { client });

    expect(screen.getByText(/live stream degraded/i)).toBeInTheDocument();
    // Cached cards stay visible — the banner marks them stale, it doesn't replace them.
    expect(screen.getByText("Greenhouse A")).toBeInTheDocument();
  });

  it("shows no stale banner when the stream is live and the poll is healthy", () => {
    setStream("open");
    const client = makeClient();
    client.setQueryData(queryKeys.fleet(), [
      sampleSummary({ id: "gh-a", displayName: "Greenhouse A" }),
    ]);
    seedSparklines(client);
    renderWithProviders(<FleetOverview />, { client });

    expect(screen.getByText("Greenhouse A")).toBeInTheDocument();
    expect(screen.queryByText(/live stream degraded/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/last known data/i)).not.toBeInTheDocument();
  });
});
