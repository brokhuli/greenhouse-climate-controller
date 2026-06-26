/**
 * One climate metric: current value and its setpoint readout (components §3). `state` recolors the
 * value when a reading crosses out of band; `dim` muffles the tile for an offline greenhouse. The
 * setpoint is either a single target or a low–high band, and the "Setpoint" line always renders
 * (placeholder "—" when no target is known) so the card's anatomy stays stable.
 */
export type MetricBandState = "in-band" | "warn" | "fault";

/** A setpoint readout: a single resolved target or a low–high band (e.g. humidity). */
export type SetpointRange = { low: number; high: number };

const STATE_COLOR: Record<MetricBandState, string> = {
  "in-band": "var(--color-fg-default)",
  warn: "var(--color-warning)",
  fault: "var(--color-fault)",
};

const formatValue = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

const isRange = (setpoint: number | SetpointRange): setpoint is SetpointRange =>
  typeof setpoint === "object";

function formatSetpoint(setpoint: number | SetpointRange | null | undefined, unit: string): string {
  if (setpoint == null) return "—";
  if (isRange(setpoint))
    return `${formatValue(setpoint.low)}–${formatValue(setpoint.high)} ${unit}`;
  return `${formatValue(setpoint)} ${unit}`;
}

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
  setpoint?: number | SetpointRange | null;
  unit: string;
  state?: MetricBandState;
  dim?: boolean;
}) {
  const hasValue = value != null;

  return (
    <div className={`border-border rounded-md border p-2.5 ${dim ? "opacity-50" : ""}`}>
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
        <span>Setpoint</span>
        <span className="tabular-nums">{formatSetpoint(setpoint, unit)}</span>
      </div>
    </div>
  );
}
