import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PipelineTracker } from "../../src/features/optimizer/PipelineTracker";
import { pipelineStages } from "../../src/features/optimizer/pipeline";
import { toOptimizerCardState } from "../../src/features/optimizer/derivations";
import { sampleFleetOptimizerGreenhouse } from "../utils";

describe("PipelineTracker outcome detail", () => {
  it("includes the failed stage's full reason in its tooltip", () => {
    const entry = sampleFleetOptimizerGreenhouse({
      status: "failed",
      reasonCode: "input_incomplete",
      currentStage: "quality_gate",
      inFlight: false,
    });
    const message = "humidity coverage 0.50 < 0.95";
    const nodes = pipelineStages(entry, toOptimizerCardState(entry, true), message);

    render(<PipelineTracker nodes={nodes} />);

    expect(screen.getByTitle(`Quality Gate — failed here: ${message}`)).toBeInTheDocument();
  });

  it("includes an unchanged stage's full reason in its tooltip", () => {
    const entry = sampleFleetOptimizerGreenhouse({
      status: "unchanged",
      currentStage: "forecast",
      inFlight: false,
    });
    const message = "no crop-safe bounds present; holding the baseline";
    const nodes = pipelineStages(entry, toOptimizerCardState(entry, true), message);

    render(<PipelineTracker nodes={nodes} />);

    expect(screen.getByTitle(`Forecast — unchanged here: ${message}`)).toBeInTheDocument();
  });
});
