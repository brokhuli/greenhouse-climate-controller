/**
 * One climate metric: label and current value (components §3). `state` recolors the value when a
 * reading crosses out of band; `dim` muffles the tile for an offline greenhouse.
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
  unit,
  state = "in-band",
  dim = false,
}: {
  label: string;
  value: number | null | undefined;
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
    </div>
  );
}
