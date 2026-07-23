import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import OptimizerConsole from "../../src/features/optimizer/OptimizerConsole";
import { queryKeys } from "../../src/api/queries/keys";
import type { EnableState, FleetOptimizerSummary, OptimizerStatus } from "../../src/api/schemas";
import {
  makeClient,
  renderWithProviders,
  sampleEscalation,
  sampleFleetOptimizerGreenhouse,
  sampleFleetOptimizerSummary,
  sampleModelState,
  sampleOptimizerStatus,
  sampleSummary,
} from "../utils";

const twoGreenhouseSummary = (): FleetOptimizerSummary =>
  sampleFleetOptimizerSummary({
    greenhouses: [
      sampleFleetOptimizerGreenhouse({ greenhouseId: "gh-a", status: "applied" }),
      sampleFleetOptimizerGreenhouse({
        greenhouseId: "gh-b",
        status: "escalated",
        reasonCode: "low_confidence",
      }),
    ],
    rollup: {
      backlog: 1,
      byOutcome: { applied: 1, escalated: 1, extended: 0 },
      oldestOpenAgeSecs: 120,
    },
  });

function seededClient(
  overrides: {
    status?: OptimizerStatus;
    fleet?: FleetOptimizerSummary;
    enabled?: EnableState;
  } = {},
): QueryClient {
  const client = makeClient();
  client.setQueryData(queryKeys.optimizerStatus(), overrides.status ?? sampleOptimizerStatus());
  client.setQueryData(queryKeys.optimizerFleet(), overrides.fleet ?? twoGreenhouseSummary());
  client.setQueryData(queryKeys.optimizerEscalations(), [
    sampleEscalation({ greenhouseId: "gh-b", reasonCode: "low_confidence" }),
  ]);
  client.setQueryData(queryKeys.optimizerModel(), sampleModelState());
  client.setQueryData(queryKeys.optimizerEnabled(), overrides.enabled ?? { enabled: true });
  client.setQueryData(queryKeys.fleet(), [
    sampleSummary({ id: "gh-a", displayName: "Greenhouse A" }),
    sampleSummary({ id: "gh-b", displayName: "Greenhouse B" }),
  ]);
  return client;
}

describe("OptimizerConsole", () => {
  it("renders a row per greenhouse with its outcome and reason", () => {
    renderWithProviders(<OptimizerConsole />, { client: seededClient(), route: "/optimizer" });
    expect(screen.getByText("Greenhouse A")).toBeInTheDocument();
    expect(screen.getByText("Greenhouse B")).toBeInTheDocument();
    // The escalated row carries its reason code + class as a chip.
    expect(screen.getByText(/low confidence · transient/i)).toBeInTheDocument();
  });

  it("filters to the escalation worklist under ?status=escalated", () => {
    renderWithProviders(<OptimizerConsole />, {
      client: seededClient(),
      route: "/optimizer?status=escalated",
    });
    expect(screen.getByText("Greenhouse B")).toBeInTheDocument();
    expect(screen.queryByText("Greenhouse A")).not.toBeInTheDocument();
  });

  it("disables every operator action for a viewer", () => {
    renderWithProviders(<OptimizerConsole />, {
      client: seededClient(),
      route: "/optimizer",
      role: "viewer",
    });
    for (const button of screen.getAllByRole("button", { name: /run cycle/i })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByLabelText("Active planning model")).toBeDisabled();
  });

  it("shows the read-only banner when the service is globally paused", () => {
    renderWithProviders(<OptimizerConsole />, {
      client: seededClient({
        enabled: { enabled: false },
        status: sampleOptimizerStatus({ enabled: false, readOnlyReason: "maintenance" }),
      }),
      route: "/optimizer",
    });
    expect(screen.getByText(/paused \(read-only\)/i)).toBeInTheDocument();
  });

  it("renders the health badge as Unavailable rather than crashing when the optimizer is down", () => {
    renderWithProviders(<OptimizerConsole />, {
      client: seededClient({
        status: sampleOptimizerStatus({ status: "unavailable", lastSuccessfulCycleAt: null }),
        fleet: sampleFleetOptimizerSummary({
          greenhouses: [],
          rollup: {
            backlog: 0,
            byOutcome: { applied: 0, escalated: 0, extended: 0 },
            oldestOpenAgeSecs: null,
          },
        }),
      }),
      route: "/optimizer",
    });
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText(/No greenhouses registered/i)).toBeInTheDocument();
  });
});
