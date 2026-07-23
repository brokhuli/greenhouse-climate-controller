import type { DegradedReason, ReasonClass, ReasonCode } from "../../api/schemas";

/**
 * Local human descriptions for the optimizer's canonical held-cycle reason codes and service
 * degradation causes — a display-side copy of the single-source-of-truth tables in the optimizer
 * interfaces spec (§Escalation reason codes, §DegradedReason). The `class` here mirrors the
 * contract's `ReasonClass`; components read whatever the API sends and fall back gracefully on a
 * code they do not recognise, so this map never has to stay perfectly in lockstep to keep rendering.
 */
export const REASON_CODES: Record<ReasonCode, { class: ReasonClass; description: string }> = {
  input_stale: { class: "transient", description: "Input telemetry is stale (freshness miss)." },
  input_incomplete: {
    class: "transient",
    description: "Input telemetry is incomplete (a required metric is missing).",
  },
  sensor_fault: { class: "transient", description: "A required sensor is faulted or degraded." },
  actuator_fault: { class: "transient", description: "An actuator is stuck or not responding." },
  clock_mode_unsupported: {
    class: "transient",
    description: "The greenhouse is running off real-time (time-scale ≠ 1×).",
  },
  contract_drift: {
    class: "persistent",
    description: "Identity or schema-version mismatch with the platform.",
  },
  twin_diverged: {
    class: "transient",
    description: "The digital twin diverged (a non-finite / out-of-envelope step).",
  },
  twin_fidelity_fault: {
    class: "persistent",
    description: "Sustained twin parameter drift (a fidelity fault).",
  },
  constraint_violation: {
    class: "persistent",
    description: "A proposed target is out of crop-safe range, or the bundle is inconsistent.",
  },
  low_confidence: {
    class: "transient",
    description: "Plan confidence fell below the auto-apply threshold.",
  },
  bounds_mismatch: {
    class: "persistent",
    description: "The platform rejected the write — a bounds disagreement (422).",
  },
  write_unauthorized: {
    class: "persistent",
    description: "The platform rejected the write — missing/invalid credentials (401/403).",
  },
  platform_unavailable: {
    class: "transient",
    description: "The platform REST API was unreachable (transport failure / timeout / 5xx).",
  },
  cycle_timeout: {
    class: "transient",
    description: "The cycle overran its timeout and was abandoned.",
  },
  llm_unavailable: {
    class: "transient",
    description: "The LLM backend was unreachable and no fallback is configured.",
  },
};

/** The triage class for a reason code, defaulting to "transient" for an unrecognised code. */
export function reasonClassForCode(code: ReasonCode): ReasonClass {
  return REASON_CODES[code]?.class ?? "transient";
}

/** Human descriptions for the service-level `OptimizerStatus.degraded_reason` causes. */
export const DEGRADED_REASONS: Record<DegradedReason, string> = {
  platform_unreachable: "The platform (Phase 2) is unreachable.",
  llm_unreachable: "The LLM backend is unreachable.",
  cycle_stalled: "Enabled, but no successful cycle within the expected cadence.",
  cold_start: "Enabled, but no successful cycle yet.",
};
