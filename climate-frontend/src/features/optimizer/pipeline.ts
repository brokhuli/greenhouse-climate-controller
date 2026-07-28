import type { CycleStage, FleetOptimizerGreenhouse, ReasonCode } from "../../api/schemas";
import type { OptimizerCardState } from "./derivations";

/**
 * Pure derivation for the per-greenhouse pipeline tracker on the optimizer console (spec 02
 * §Pipeline). A planning cycle advances through six ordered stages; this maps a fleet row's live
 * progress (`inFlight` + `currentStage`) and its settled outcome onto a per-stage display state so
 * the tracker reads the same whether a cycle is running now or shows where the last one stopped.
 *
 * Kept out of the component (like `toOptimizerCardState`) so the stage precedence is unit-tested.
 */

export type PipelineNodeState = "done" | "active" | "failed" | "held" | "pending" | "idle";
export type PipelineNode = {
  stage: CycleStage;
  label: string;
  state: PipelineNodeState;
  /** Detailed outcome text, present only on the settled failed/held terminal stage. */
  message?: string;
};

/** The pipeline stages in execution order, with their operator-facing labels. */
export const CYCLE_STAGES: ReadonlyArray<{ stage: CycleStage; label: string }> = [
  { stage: "ingest", label: "Ingest" },
  { stage: "quality_gate", label: "Quality Gate" },
  { stage: "forecast", label: "Forecast" },
  { stage: "plan", label: "Plan" },
  { stage: "constrain", label: "Constrain" },
  { stage: "publish", label: "Publish" },
];

const STAGE_INDEX: Record<CycleStage, number> = CYCLE_STAGES.reduce(
  (acc, s, i) => ({ ...acc, [s.stage]: i }),
  {} as Record<CycleStage, number>,
);

/**
 * The stage each escalation reason code is attributed to — the fallback used to place the failure
 * marker when there is no live `currentStage` (e.g. a settled row after an optimizer restart cleared
 * the in-memory progress). Live cycles use the real `currentStage`; this only backstops that gap.
 * A few codes can arise at more than one stage upstream; each is mapped to its most representative.
 */
export const STAGE_FOR_REASON_CODE: Record<ReasonCode, CycleStage> = {
  // Read / identity.
  contract_drift: "ingest",
  platform_unavailable: "ingest",
  // Input-quality gate.
  input_stale: "quality_gate",
  input_incomplete: "quality_gate",
  sensor_fault: "quality_gate",
  actuator_fault: "quality_gate",
  clock_mode_unsupported: "quality_gate",
  // Forecast / twin.
  twin_diverged: "forecast",
  twin_fidelity_fault: "forecast",
  // Plan (LLM).
  llm_unavailable: "plan",
  plan_unparseable: "plan",
  cycle_timeout: "plan",
  internal_error: "plan",
  // Constraint / confidence gate.
  constraint_violation: "constrain",
  low_confidence: "constrain",
  // Publish (setpoint write).
  bounds_mismatch: "publish",
  write_unauthorized: "publish",
};

const idleTrack = (): PipelineNode[] => CYCLE_STAGES.map((s) => ({ ...s, state: "idle" as const }));

/**
 * Resolve the six-node pipeline tracker for one greenhouse. States:
 * - `done` — a stage the cycle cleared; `active` — the stage a cycle is executing now (in flight);
 * - `failed` — where a settled cycle escalated; `held` — where an `extended` cycle benignly stopped;
 * - `pending` — a stage not yet reached; `idle` — no cycle to show (read-only / disabled / no plan).
 */
export function pipelineStages(
  entry: FleetOptimizerGreenhouse | undefined,
  cardState: OptimizerCardState,
  outcomeMessage?: string | null,
): PipelineNode[] {
  const inFlight = entry?.inFlight ?? false;

  // Nothing to show: not running, and no settled outcome (read-only / disabled / never-cycled).
  if (!inFlight && cardState.kind !== "outcome") return idleTrack();

  // Where the cycle is (live) or stopped (settled): prefer the live stage; else, for an escalation,
  // fall back to the reason-code attribution; else the pipeline can't be placed.
  const stageFromReason =
    cardState.kind === "outcome" && cardState.reasonCode
      ? STAGE_FOR_REASON_CODE[cardState.reasonCode]
      : null;
  const activeStage = entry?.currentStage ?? stageFromReason ?? null;
  if (activeStage === null) return idleTrack();
  const activeIndex = STAGE_INDEX[activeStage];

  // An applied cycle reached publish and completed it (done, not a mid-stage marker).
  const appliedComplete =
    !inFlight && cardState.kind === "outcome" && cardState.status === "applied";

  // The disposition of the stage the cycle sits on when settled.
  const marker: PipelineNodeState = inFlight
    ? "active"
    : cardState.kind === "outcome" && cardState.status === "escalated"
      ? "failed"
      : "held"; // extended: a benign hold, not a failure

  return CYCLE_STAGES.map((s, i) => {
    let state: PipelineNodeState;
    if (i < activeIndex) state = "done";
    else if (i > activeIndex) state = "pending";
    else state = appliedComplete ? "done" : marker;
    return {
      ...s,
      state,
      message:
        i === activeIndex && (state === "failed" || state === "held")
          ? (outcomeMessage ?? undefined)
          : undefined,
    };
  });
}
