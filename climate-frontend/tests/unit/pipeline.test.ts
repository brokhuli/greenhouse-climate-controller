import { describe, expect, it } from "vitest";
import type { CycleStage, FleetOptimizerGreenhouse } from "../../src/api/schemas";
import { reasonCodeSchema } from "../../src/api/schemas";
import { toOptimizerCardState } from "../../src/features/optimizer/derivations";
import {
  CYCLE_STAGES,
  STAGE_FOR_REASON_CODE,
  pipelineStages,
  type PipelineNodeState,
} from "../../src/features/optimizer/pipeline";
import { sampleFleetOptimizerGreenhouse } from "../utils";

/** Resolve the tracker for a row and index its node states by stage for easy assertion. */
function statesFor(
  entry: FleetOptimizerGreenhouse | undefined,
  serviceEnabled = true,
): Record<CycleStage, PipelineNodeState> {
  const nodes = pipelineStages(entry, toOptimizerCardState(entry, serviceEnabled));
  return Object.fromEntries(nodes.map((n) => [n.stage, n.state])) as Record<
    CycleStage,
    PipelineNodeState
  >;
}

describe("pipelineStages — live progress", () => {
  it("marks the in-flight stage active, earlier done, later pending", () => {
    const s = statesFor(
      sampleFleetOptimizerGreenhouse({
        status: null,
        createdAt: null,
        inFlight: true,
        currentStage: "forecast",
      }),
    );
    expect(s).toMatchObject({
      ingest: "done",
      quality_gate: "done",
      forecast: "active",
      plan: "pending",
      constrain: "pending",
      publish: "pending",
    });
  });

  it("an applied cycle completes the whole pipeline (publish done)", () => {
    const s = statesFor(
      sampleFleetOptimizerGreenhouse({
        status: "applied",
        inFlight: false,
        currentStage: "publish",
      }),
    );
    expect(Object.values(s).every((state) => state === "done")).toBe(true);
  });
});

describe("pipelineStages — settled outcomes", () => {
  it("a held plan stops at its stage; earlier stages are done", () => {
    const s = statesFor(
      sampleFleetOptimizerGreenhouse({
        status: "held",
        reasonCode: "low_confidence",
        inFlight: false,
        currentStage: "constrain",
      }),
    );
    expect(s.forecast).toBe("done");
    expect(s.plan).toBe("done");
    expect(s.constrain).toBe("held");
    expect(s.publish).toBe("pending");
  });

  it("an unchanged cycle is marked unchanged at its stage", () => {
    const s = statesFor(
      sampleFleetOptimizerGreenhouse({ status: "unchanged", inFlight: false, currentStage: "plan" }),
    );
    expect(s.plan).toBe("unchanged");
    expect(s.forecast).toBe("done");
    expect(s.constrain).toBe("pending");
  });

  it("falls back to the reason-code stage when there is no live current_stage", () => {
    // After a restart clears in-memory progress, a settled escalation still places its marker.
    const s = statesFor(
      sampleFleetOptimizerGreenhouse({
        status: "held",
        reasonCode: "input_stale",
        inFlight: false,
        currentStage: null,
      }),
    );
    expect(s.quality_gate).toBe("held");
    expect(s.ingest).toBe("done");
    expect(s.forecast).toBe("pending");
  });
});

describe("pipelineStages — nothing to show", () => {
  it("is idle when the service is globally paused (read-only)", () => {
    const s = statesFor(sampleFleetOptimizerGreenhouse(), false);
    expect(Object.values(s).every((state) => state === "idle")).toBe(true);
  });

  it("is idle when the greenhouse is disabled", () => {
    const s = statesFor(sampleFleetOptimizerGreenhouse({ enabled: false }));
    expect(Object.values(s).every((state) => state === "idle")).toBe(true);
  });

  it("is idle for a never-cycled greenhouse with no plan", () => {
    const s = statesFor(
      sampleFleetOptimizerGreenhouse({
        status: null,
        createdAt: null,
        inFlight: false,
        currentStage: null,
      }),
    );
    expect(Object.values(s).every((state) => state === "idle")).toBe(true);
  });

  it("shows live progress even before the first outcome when a cycle is in flight", () => {
    const s = statesFor(
      sampleFleetOptimizerGreenhouse({
        status: null,
        createdAt: null,
        inFlight: true,
        currentStage: "ingest",
      }),
    );
    expect(s.ingest).toBe("active");
  });
});

describe("STAGE_FOR_REASON_CODE", () => {
  it("maps every canonical reason code to a real pipeline stage", () => {
    const stages = new Set(CYCLE_STAGES.map((s) => s.stage));
    for (const code of reasonCodeSchema.options) {
      const stage = STAGE_FOR_REASON_CODE[code];
      expect(stage, `no stage for ${code}`).toBeDefined();
      expect(stages.has(stage)).toBe(true);
    }
  });

  it("attributes a plan parse failure to the plan stage", () => {
    expect(STAGE_FOR_REASON_CODE.plan_unparseable).toBe("plan");
  });
});
