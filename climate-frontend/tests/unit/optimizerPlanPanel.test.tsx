import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { OptimizerPlanPanel } from "../../src/features/optimizer/OptimizerPlanPanel";
import { queryKeys } from "../../src/api/queries/keys";
import type { EnableState, OptimizerPlanDetail, OptimizerStatus } from "../../src/api/schemas";
import {
  makeClient,
  renderWithProviders,
  sampleOptimizerPlanDetail,
  sampleOptimizerStatus,
} from "../utils";

const GH = "gh-a";

function seededClient(
  overrides: {
    status?: OptimizerStatus;
    enabled?: EnableState;
    greenhouseEnabled?: boolean;
    plan?: OptimizerPlanDetail | "unset";
  } = {},
): QueryClient {
  const client = makeClient();
  client.setQueryData(queryKeys.optimizerStatus(), overrides.status ?? sampleOptimizerStatus());
  client.setQueryData(queryKeys.optimizerEnabled(), overrides.enabled ?? { enabled: true });
  client.setQueryData(queryKeys.optimizerGreenhouseEnabled(GH), {
    greenhouseId: GH,
    enabled: overrides.greenhouseEnabled ?? true,
  });
  client.setQueryData(queryKeys.optimizerEscalations(), []);
  if (overrides.plan !== "unset") {
    client.setQueryData(queryKeys.optimizerPlan(GH), overrides.plan ?? sampleOptimizerPlanDetail());
  }
  return client;
}

const render = (client: QueryClient, role?: "viewer" | "operator") =>
  renderWithProviders(<OptimizerPlanPanel greenhouseId={GH} displayName="Greenhouse A" />, {
    client,
    role,
  });

describe("OptimizerPlanPanel", () => {
  it("renders confidence, backend provenance, and the setpoint diff for an applied plan", () => {
    render(seededClient());
    expect(screen.getByText(/Confidence 91%/)).toBeInTheDocument();
    expect(screen.getByText(/Pre-cool ahead of the solar peak/)).toBeInTheDocument();
    expect(screen.getByText(/ollama · llama3 · v1 · primary/)).toBeInTheDocument();
    // The diff table lists the changed scalar fields.
    expect(screen.getByText("Temp (day)")).toBeInTheDocument();
    expect(screen.getByText("VPD target")).toBeInTheDocument();
  });

  it("shows a held cycle's outcome and reason with no diff", () => {
    render(
      seededClient({
        plan: {
          plan: {
            ...sampleOptimizerPlanDetail().plan,
            outcome: { status: "escalated", reasonCode: "input_stale", message: "stream stale" },
            plan: null,
          },
          diff: null,
        },
      }),
    );
    expect(screen.getByText("Escalated")).toBeInTheDocument();
    expect(screen.getByText(/input stale/i)).toBeInTheDocument();
    expect(screen.getByText(/Cycle ran; nothing applied/i)).toBeInTheDocument();
    expect(screen.queryByText("Temp (day)")).not.toBeInTheDocument();
  });

  it("shows the cold-start empty state before the first cycle", async () => {
    render(seededClient({ plan: "unset" }));
    expect(await screen.findByText(/No optimizer plan yet/i)).toBeInTheDocument();
  });

  it("reflects a global pause as Read-only and disables the per-greenhouse toggle", () => {
    render(
      seededClient({
        enabled: { enabled: false },
        status: sampleOptimizerStatus({ enabled: false }),
      }),
      "operator",
    );
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pause/i })).toBeDisabled();
  });

  it("is absent entirely when the optimizer is unavailable", () => {
    render(seededClient({ status: sampleOptimizerStatus({ status: "unavailable" }) }));
    expect(screen.queryByText("Optimizer")).not.toBeInTheDocument();
  });
});
