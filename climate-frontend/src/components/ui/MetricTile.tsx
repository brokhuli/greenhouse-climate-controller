import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { readingVsSetpointDelta } from "../../lib/derivations";

/**
 * One climate metric: current value, its setpoint, and the signed delta (components §3). Uses the
 * `readingVsSetpointDelta` derivation rather than recomputing inline. `state` recolors the value
 * when a reading crosses out of band; `dim` muffles the tile for an offline greenhouse.
 */
export type MetricBandState = "in-band" | "warn" | "fault";

const STATE_COLOR: Record<MetricBandState, string> = {
  "in-band": "var(--color-fg-default)",
  warn: "var(--color-warning)",
  fault: "var(--color-fault)",
};

const formatValue = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

export function MetricTile({
  label,
  value,
  setpoint,
  unit,
  state = "in-band",
  dim = false,
}: {
  label: string;
  value: number | null | undefined;
  setpoint?: number | null;
  unit: string;
  state?: MetricBandState;
  dim?: boolean;
}) {
  const { delta, direction } = readingVsSetpointDelta(value, setpoint);
  const hasValue = value != null;
  const DeltaIcon = direction === "above" ? ArrowUp : direction === "below" ? ArrowDown : Minus;

  return (
    <div className={dim ? "opacity-50" : undefined}>
      <p className="section-label">{label}</p>
      <div className="mt-1 flex items-baseline gap-1">
        <span
          className="font-mono text-lg font-semibold tabular-nums"
          style={{ color: hasValue ? STATE_COLOR[state] : "var(--color-fg-subtle)" }}
        >
          {hasValue ? formatValue(value) : "—"}
        </span>
        <span className="text-fg-muted text-xs">{unit}</span>
      </div>
      <div className="text-fg-subtle mt-0.5 flex items-center gap-1 text-xs">
        {setpoint != null ? (
          <>
            <span>target {formatValue(setpoint)}</span>
            {delta != null && direction !== "equal" ? (
              <span className="inline-flex items-center">
                <DeltaIcon size={11} aria-hidden />
                {formatValue(Math.abs(delta))}
              </span>
            ) : null}
          </>
        ) : (
          <span>no target</span>
        )}
      </div>
    </div>
  );
}
