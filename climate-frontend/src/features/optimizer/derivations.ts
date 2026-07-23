import type {
  Escalation,
  FieldBound,
  FleetOptimizerGreenhouse,
  OptimizerOutcomeStatus,
  OptimizerStatus,
  ReasonCode,
  ScalarSetpointKey,
  SetpointDiff,
} from "../../api/schemas";
import { reasonClassForCode } from "./reasonCodes";

/**
 * Pure view-model derivations for the Phase 3 optimizer console (data-model §8). Kept out of the
 * components so the pill/state precedence, the setpoint-diff shaping, and the escalation triage
 * ordering are unit-tested in isolation and never recomputed inline.
 */

// ---------------------------------------------------------------------------
// Card / pill state — the `toOptimizerCardState` derivation
// ---------------------------------------------------------------------------

/**
 * The resolved optimizer pill state for one greenhouse. Precedence (data-model §8):
 * Read-only (service globally paused) → Disabled (this greenhouse paused) → the cycle outcome →
 * No plan (no entry — a never-planned greenhouse is omitted from the fleet summary).
 */
export type OptimizerCardState =
  | { kind: "read-only" }
  | { kind: "disabled" }
  | { kind: "no-plan" }
  | { kind: "outcome"; status: OptimizerOutcomeStatus; reasonCode: ReasonCode | null };

export function toOptimizerCardState(
  entry: FleetOptimizerGreenhouse | undefined,
  serviceEnabled: boolean,
): OptimizerCardState {
  // Global pause takes precedence over every per-greenhouse state.
  if (!serviceEnabled) return { kind: "read-only" };
  // The fleet summary omits never-planned greenhouses, so an absent entry reads as "No plan".
  if (!entry) return { kind: "no-plan" };
  if (!entry.enabled) return { kind: "disabled" };
  return { kind: "outcome", status: entry.status, reasonCode: entry.reasonCode };
}

// ---------------------------------------------------------------------------
// Escalation triage ordering — persistent before transient, oldest first
// ---------------------------------------------------------------------------

/** Order open escalations for the worklist: persistent codes first, then oldest-first within a class. */
export function sortEscalationsByTriage(escalations: Escalation[]): Escalation[] {
  const rank = (e: Escalation): number => (e.reasonClass === "persistent" ? 0 : 1);
  return [...escalations].sort(
    (a, b) => rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

/**
 * Comparator for the fleet table's escalated rows (the worklist filter). The fleet summary carries
 * only the reason *code*, so the class is derived from the canonical table; persistent sorts first,
 * then oldest-first.
 */
export function compareFleetTriage(
  a: FleetOptimizerGreenhouse,
  b: FleetOptimizerGreenhouse,
): number {
  const rank = (g: FleetOptimizerGreenhouse): number =>
    g.reasonCode && reasonClassForCode(g.reasonCode) === "persistent" ? 0 : 1;
  return rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime();
}

// ---------------------------------------------------------------------------
// Setpoint diff — the changed-field rows the plan panel renders
// ---------------------------------------------------------------------------

/** How close to a crop-safe bound a proposed value must be to earn the near-bound flag. */
export const NEAR_BOUND_FRACTION = 0.05;

/** Whether a proposed value sits at or within `NEAR_BOUND_FRACTION` of either crop-safe bound. */
export function isNearBound(value: number, bound: FieldBound): boolean {
  const range = bound.max - bound.min;
  if (range <= 0) return value <= bound.min || value >= bound.max;
  const margin = range * NEAR_BOUND_FRACTION;
  return value <= bound.min + margin || value >= bound.max - margin;
}

export type SetpointDiffRow = {
  /** The wire (snake_case) field name — stable id + the key into `bounds`. */
  field: string;
  label: string;
  unit: string;
  current: number;
  proposed: number;
  direction: "up" | "down" | "same";
  nearBound: boolean;
  bound: FieldBound | null;
};

type DiffField = { wireKey: string; camelKey: ScalarSetpointKey; label: string; unit: string };

// The scalar climate setpoints the planner refines and the diff renders. Non-scalar setpoints
// (day/night window times, per-zone irrigation) are outside the planner's v1 refinement scope and
// carry no crop-safe bound, so they are not part of the diff table.
const DIFF_FIELDS: DiffField[] = [
  { wireKey: "temperature_day_c", camelKey: "temperatureDayC", label: "Temp (day)", unit: "°C" },
  {
    wireKey: "temperature_night_c",
    camelKey: "temperatureNightC",
    label: "Temp (night)",
    unit: "°C",
  },
  { wireKey: "humidity_low_pct", camelKey: "humidityLowPct", label: "Humidity low", unit: "%" },
  { wireKey: "humidity_high_pct", camelKey: "humidityHighPct", label: "Humidity high", unit: "%" },
  {
    wireKey: "humidity_deadband_pct",
    camelKey: "humidityDeadbandPct",
    label: "Humidity deadband",
    unit: "%",
  },
  { wireKey: "co2_target_ppm", camelKey: "co2TargetPpm", label: "CO₂ target", unit: "ppm" },
  {
    wireKey: "co2_vent_interlock_threshold_pct",
    camelKey: "co2VentInterlockThresholdPct",
    label: "CO₂ vent interlock",
    unit: "%",
  },
  { wireKey: "vpd_target_kpa", camelKey: "vpdTargetKpa", label: "VPD target", unit: "kPa" },
  { wireKey: "dli_target_mol", camelKey: "dliTargetMol", label: "DLI target", unit: "mol" },
];

/** The changed scalar setpoints, each with direction and a crop-safe near-bound flag. */
export function setpointDiffRows(diff: SetpointDiff): SetpointDiffRow[] {
  const rows: SetpointDiffRow[] = [];
  for (const f of DIFF_FIELDS) {
    const proposed = diff.proposed[f.camelKey];
    if (typeof proposed !== "number") continue; // not part of this proposal
    const current = diff.current[f.camelKey];
    const bound = diff.bounds[f.wireKey] ?? null;
    const direction = proposed > current ? "up" : proposed < current ? "down" : "same";
    rows.push({
      field: f.wireKey,
      label: f.label,
      unit: f.unit,
      current,
      proposed,
      direction,
      nearBound: bound ? isNearBound(proposed, bound) : false,
      bound,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Service-health staleness — last successful cycle vs the expected cadence
// ---------------------------------------------------------------------------

export type CycleAge = { ageSecs: number | null; stale: boolean };

/** Age of the last successful cycle and whether it has aged past the expected cadence. */
export function lastCycleAge(status: OptimizerStatus, now: Date = new Date()): CycleAge {
  if (!status.lastSuccessfulCycleAt) return { ageSecs: null, stale: false };
  const ageSecs = Math.max(
    0,
    Math.round((now.getTime() - status.lastSuccessfulCycleAt.getTime()) / 1000),
  );
  return { ageSecs, stale: status.enabled && ageSecs > status.cadenceSecs };
}

/** Compact human duration for ages / cadence, e.g. 90 → "1m 30s", 5400 → "1h 30m". */
export function formatDurationSecs(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const minutes = Math.floor(secs / 60);
  if (minutes < 60) {
    const remSecs = secs % 60;
    return remSecs ? `${minutes}m ${remSecs}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMins = minutes % 60;
  return remMins ? `${hours}h ${remMins}m` : `${hours}h`;
}
