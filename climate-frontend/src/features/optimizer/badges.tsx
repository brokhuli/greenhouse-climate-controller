import {
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CirclePause,
  CloudOff,
  Lock,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type {
  OptimizerOutcomeStatus,
  OptimizerStatus,
  ReasonClass,
  ReasonCode,
} from "../../api/schemas";
import { Pill } from "../../components/ui/Pill";
import { DEGRADED_REASONS, REASON_CODES, reasonClassForCode } from "./reasonCodes";
import { lastCycleAge, formatDurationSecs, type OptimizerCardState } from "./derivations";

// Shared token colors. Applied is the healthy green; escalated the attention orange; extended a
// benign informational blue; every "not actively planning" state (disabled / read-only / no plan /
// unavailable) uses the muted offline grey — an absence of activity, not an alarm.
const APPLIED = "var(--color-status-online)";
const ESCALATED = "var(--color-status-degraded)";
const EXTENDED = "var(--color-info)";
const MUTED = "var(--color-status-offline)";
const PERSISTENT = "var(--color-fault)";
const TRANSIENT = "var(--color-warning)";

const OUTCOME_META: Record<
  OptimizerOutcomeStatus,
  { label: string; color: string; Icon: LucideIcon }
> = {
  applied: { label: "Applied", color: APPLIED, Icon: CircleCheck },
  escalated: { label: "Escalated", color: ESCALATED, Icon: TriangleAlert },
  extended: { label: "Extended", color: EXTENDED, Icon: CircleMinus },
};

/** The `applied` / `escalated` / `extended` cycle-outcome pill (text + icon, never color-only). */
export function PlanOutcomeBadge({ status }: { status: OptimizerOutcomeStatus }) {
  const { label, color, Icon } = OUTCOME_META[status];
  return (
    <Pill color={color} icon={<Icon size={12} aria-hidden />}>
      {label}
    </Pill>
  );
}

/**
 * The compact per-greenhouse pill on a fleet card and in the fleet table's status cell. Resolves the
 * `toOptimizerCardState` precedence into a label + icon; carries no confidence (unavailable at fleet
 * scope — that lives on the detail plan panel).
 */
export function OptimizerStatusPill({ state }: { state: OptimizerCardState }) {
  if (state.kind === "outcome") return <PlanOutcomeBadge status={state.status} />;
  const meta: Record<
    Exclude<OptimizerCardState["kind"], "outcome">,
    { label: string; Icon: LucideIcon }
  > = {
    "read-only": { label: "Read-only", Icon: Lock },
    disabled: { label: "Disabled", Icon: CirclePause },
    "no-plan": { label: "No plan", Icon: CircleDashed },
  };
  const { label, Icon } = meta[state.kind];
  return (
    <Pill color={MUTED} icon={<Icon size={12} aria-hidden />}>
      {label}
    </Pill>
  );
}

/**
 * A held-cycle reason code with its triage class; the tooltip carries the human description. Does not
 * hardcode the code list — an unrecognised code still renders (formatted) with a transient default.
 */
export function ReasonCodeChip({
  code,
  reasonClass,
}: {
  code: ReasonCode;
  reasonClass?: ReasonClass;
}) {
  const klass = reasonClass ?? reasonClassForCode(code);
  const description = REASON_CODES[code]?.description ?? code;
  const label = code.replace(/_/g, " ");
  const color = klass === "persistent" ? PERSISTENT : TRANSIENT;
  return (
    <Pill
      color={color}
      icon={<CircleHelp size={12} aria-hidden />}
      title={`${description} (${klass})`}
    >
      {label} · {klass}
    </Pill>
  );
}

const HEALTH_META: Record<
  OptimizerStatus["status"],
  { label: string; color: string; Icon: LucideIcon }
> = {
  healthy: { label: "Healthy", color: APPLIED, Icon: CircleCheck },
  degraded: { label: "Degraded", color: ESCALATED, Icon: TriangleAlert },
  unavailable: { label: "Unavailable", color: MUTED, Icon: CloudOff },
};

/**
 * The service-health badge: overall status + (when degraded) the reason, the last-successful-cycle
 * age against the expected cadence (flagged when stale), and the read-only reason when paused. A
 * read-only pause is shown as a healthy, intentional state, not a stall.
 */
export function OptimizerHealthBadge({
  status,
  now = new Date(),
}: {
  status: OptimizerStatus;
  now?: Date;
}) {
  // An intentional pause overrides the "healthy" badge with a calm read-only marker.
  const paused = !status.enabled;
  const meta = HEALTH_META[status.status];
  const { ageSecs, stale } = lastCycleAge(status, now);

  const headline = paused
    ? { label: "Read-only", color: MUTED, Icon: CirclePause as LucideIcon }
    : meta;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Pill color={headline.color} icon={<headline.Icon size={12} aria-hidden />}>
          {headline.label}
        </Pill>
        {status.status === "degraded" && status.degradedReason ? (
          <span className="text-fg-muted text-xs">
            {DEGRADED_REASONS[status.degradedReason] ?? status.degradedReason}
          </span>
        ) : null}
      </div>
      <p className="text-fg-subtle text-xs">
        {ageSecs == null ? (
          "No successful cycle yet"
        ) : (
          <span style={stale ? { color: "var(--color-status-degraded)" } : undefined}>
            Last cycle {formatDurationSecs(ageSecs)} ago
            {stale ? " — overdue" : ""}
          </span>
        )}
        {" · cadence "}
        {formatDurationSecs(status.cadenceSecs)}
      </p>
      {paused && status.readOnlyReason ? (
        <p className="text-fg-subtle text-xs">Paused: {status.readOnlyReason}</p>
      ) : null}
    </div>
  );
}
