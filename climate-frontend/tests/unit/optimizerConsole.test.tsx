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
        status: "held",
        reasonCode: "low_confidence",
        message: "confidence 0.62 < threshold 0.80",
      }),
    ],
    rollup: {
      backlog: 1,
      byOutcome: { applied: 1, unchanged: 0, held: 1, failed: 0 },
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

  it("surfaces the specific gate message on a held row", () => {
    // The precise cause (which metric / what coverage) reaches the browser on the escalation;
    // the fleet row must render it, not just the generic reason-code chip.
    renderWithProviders(<OptimizerConsole />, { client: seededClient(), route: "/optimizer" });
    expect(screen.getByText(/confidence 0\.62 < threshold 0\.80/i)).toBeInTheDocument();
  });

  it("explains a benign Forecast hold directly in the fleet row", () => {
    renderWithProviders(<OptimizerConsole />, {
      client: seededClient({
        fleet: sampleFleetOptimizerSummary({
          greenhouses: [
            sampleFleetOptimizerGreenhouse({
              status: "unchanged",
              message: "no crop-safe bounds present; holding the baseline",
              currentStage: "forecast",
            }),
          ],
          rollup: {
            backlog: 0,
            byOutcome: { applied: 0, unchanged: 1, held: 0, failed: 0 },
            oldestOpenAgeSecs: null,
          },
        }),
      }),
      route: "/optimizer",
    });

    expect(
      screen.getByText(/forecast unchanged: no crop-safe bounds present; holding the baseline/i),
    ).toBeInTheDocument();
  });

  it.each([
    ["ingest", "platform_unavailable", "platform request timed out", "Ingest failed"],
    ["quality_gate", "input_incomplete", "humidity coverage 0.50 < 0.95", "Quality Gate held"],
    ["constrain", "low_confidence", "confidence 0.62 < threshold 0.80", "Constrain held"],
  ] as const)(
    "labels the %s failure with its actionable reason",
    (stage, reasonCode, message, label) => {
      renderWithProviders(<OptimizerConsole />, {
        client: seededClient({
          fleet: sampleFleetOptimizerSummary({
            greenhouses: [
              sampleFleetOptimizerGreenhouse({
                status: reasonCode === "platform_unavailable" ? "failed" : "held",
                reasonCode,
                message,
                currentStage: stage,
              }),
            ],
            rollup: {
              backlog: 1,
              byOutcome: {
                applied: 0,
                unchanged: 0,
                held: reasonCode === "platform_unavailable" ? 0 : 1,
                failed: reasonCode === "platform_unavailable" ? 1 : 0,
              },
              oldestOpenAgeSecs: 30,
            },
          }),
        }),
        route: "/optimizer",
      });

      expect(screen.getByText(`${label}: ${message}`)).toBeInTheDocument();
    },
  );

  it("labels an offline greenhouse 'not planning' instead of an escalation", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.optimizerStatus(), sampleOptimizerStatus());
    client.setQueryData(
      queryKeys.optimizerFleet(),
      sampleFleetOptimizerSummary({
        greenhouses: [
          sampleFleetOptimizerGreenhouse({
            greenhouseId: "gh-c",
            status: "held",
            reasonCode: "input_incomplete",
          }),
        ],
        rollup: {
          backlog: 0,
          byOutcome: { applied: 0, unchanged: 0, held: 1, failed: 0 },
          oldestOpenAgeSecs: null,
        },
      }),
    );
    client.setQueryData(queryKeys.optimizerEscalations(), []);
    client.setQueryData(queryKeys.optimizerModel(), sampleModelState());
    client.setQueryData(queryKeys.optimizerEnabled(), { enabled: true });
    client.setQueryData(queryKeys.fleet(), [
      sampleSummary({ id: "gh-c", displayName: "Greenhouse C", status: "offline" }),
    ]);

    renderWithProviders(<OptimizerConsole />, { client, route: "/optimizer" });

    expect(screen.getByText(/offline.*not planning/i)).toBeInTheDocument();
    // The misleading transient reason chip is suppressed for an offline greenhouse.
    expect(screen.queryByText(/input incomplete/i)).not.toBeInTheDocument();
  });

  it("filters to held outcomes under ?status=held", () => {
    renderWithProviders(<OptimizerConsole />, {
      client: seededClient(),
      route: "/optimizer?status=held",
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
            byOutcome: { applied: 0, unchanged: 0, held: 0, failed: 0 },
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
