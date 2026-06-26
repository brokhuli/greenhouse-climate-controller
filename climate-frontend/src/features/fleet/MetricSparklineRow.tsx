import type { SeriesPoint } from "../../lib/derivations";
import { TimeSeriesChart } from "../../components/ui/TimeSeriesChart";

const SPARKLINE_HEIGHT = 28;

const formatValue = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

/**
 * One metric on a fleet card: `label: value unit` on the left and a compact sparkline on the right
 * (components §2 / the four-metric card). The line color is supplied by the card — green while
 * in-range today; the seam for future out-of-range banding. Falls back to a muted placeholder when
 * the greenhouse is offline or has no points yet, so the card's row height stays stable.
 */
export function MetricSparklineRow({
  label,
  value,
  unit,
  points,
  color,
  offline = false,
}: {
  label: string;
  value: number | null;
  unit: string;
  points: SeriesPoint[];
  color: string;
  offline?: boolean;
}) {
  const hasValue = value != null;

  return (
    <div className={`flex items-center gap-3 ${offline ? "opacity-50" : ""}`}>
      <div className="flex shrink-0 items-baseline gap-1.5">
        <span className="text-fg-muted text-sm">{label}</span>
        <span
          className="font-mono text-base font-semibold tabular-nums"
          style={{ color: hasValue ? "var(--color-fg-default)" : "var(--color-fg-subtle)" }}
        >
          {hasValue ? formatValue(value) : "—"}
        </span>
        <span className="text-fg-muted text-xs">{unit}</span>
      </div>
      <div className="ml-auto min-w-[72px] flex-1" style={{ height: SPARKLINE_HEIGHT }}>
        {points.length > 0 ? (
          <TimeSeriesChart
            variant="sparkline"
            height={SPARKLINE_HEIGHT}
            unit={unit}
            series={{ label, color, points }}
          />
        ) : (
          <div className="text-fg-subtle flex h-full items-center justify-end text-xs">
            {offline ? "offline" : "—"}
          </div>
        )}
      </div>
    </div>
  );
}
