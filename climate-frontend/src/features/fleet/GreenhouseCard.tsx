import { memo } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import type { Connectivity, GreenhouseSummary, Reading } from "../../api/schemas";
import { liveSeriesKey, useLiveSeries } from "../../hooks/useLiveSeries";
import { mergeReadings } from "../../lib/derivations";
import { MetricTile } from "../../components/ui/MetricTile";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { TimeScaleIndicator } from "../../components/ui/TimeScaleControl";
import { TimeSeriesChart } from "../../components/ui/TimeSeriesChart";

const CHART_HEIGHT = 48;
const TEMPERATURE_CHART_COLOR = "var(--chart-temperature)";

const NO_HISTORY: readonly Reading[] = [];

/**
 * The per-card accent for status UI: connectivity color, with drift taking over an otherwise-online
 * card. Offline and degraded outrank drift since they're the more pressing signal.
 */
function accentColor(status: Connectivity, drift: boolean): string {
  if (status === "offline") return "var(--color-status-offline)";
  if (status === "degraded") return "var(--color-status-degraded)";
  if (drift) return "var(--color-status-drift)";
  return "var(--color-status-online)";
}

/**
 * One greenhouse in the fleet grid (components §2). The whole card links to the detail view; an
 * offline greenhouse mutes without changing the card's anatomy (stable min-height so the grid
 * doesn't reflow). Memoized so a frame for greenhouse B doesn't re-render greenhouse A's card.
 */
function GreenhouseCardImpl({
  summary,
  history = NO_HISTORY,
  windowMs,
}: {
  summary: GreenhouseSummary;
  history?: readonly Reading[];
  /** Visible span (ms), from the fleet range picker — keeps the merge bound matched to the fetched window. */
  windowMs: number;
}) {
  const live = useLiveSeries(summary.id);
  // History (batched REST seed) is the base; the live WebSocket tail wins on timestamp collisions.
  const points = mergeReadings(history, live.get(liveSeriesKey("temperature")) ?? [], {
    windowMs,
  });
  const offline = summary.status === "offline";
  const showSpeed = summary.timeScale != null && summary.timeScale !== 1;
  const accent = accentColor(summary.status, summary.drift);

  return (
    <Link
      to={`/greenhouses/${summary.id}`}
      className={`border-border bg-surface-1 hover:border-border-strong flex flex-col gap-3 rounded-lg border px-3 pt-3 pb-1 transition-colors duration-[var(--motion-instant)] ${
        offline ? "opacity-70" : ""
      }`}
      style={{ minHeight: 200 }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="inline-block shrink-0 rounded-full"
            style={{
              width: "var(--size-status-dot)",
              height: "var(--size-status-dot)",
              backgroundColor: accent,
            }}
          />
          <span className="text-fg-default truncate text-base font-semibold">
            {summary.displayName}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {showSpeed && summary.timeScale != null ? (
            <TimeScaleIndicator scale={summary.timeScale} />
          ) : null}
          <ChevronRight size={18} className="text-fg-subtle" aria-hidden />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-fg-muted truncate text-sm">{summary.crop ?? ""}</span>
        <StatusBadge status={summary.status} drift={summary.drift} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <MetricTile
          label="Temperature"
          value={summary.climate.temperature}
          unit="°C"
          dim={offline}
        />
        <MetricTile label="Humidity" value={summary.climate.humidity} unit="%" dim={offline} />
        <MetricTile label="CO₂" value={summary.climate.co2} unit="ppm" dim={offline} />
        <MetricTile label="DLI" value={summary.climate.dli} unit="mol·m⁻²·d⁻¹" dim={offline} />
      </div>

      <div className="mt-auto">
        {points.length > 0 ? (
          <TimeSeriesChart
            variant="card"
            height={CHART_HEIGHT}
            unit="°C"
            series={{ label: "Temperature", color: TEMPERATURE_CHART_COLOR, points }}
          />
        ) : (
          <div
            className="text-fg-subtle flex items-center text-xs"
            style={{ height: CHART_HEIGHT }}
          >
            {offline ? "offline — no live data" : "awaiting telemetry…"}
          </div>
        )}
      </div>
    </Link>
  );
}

export const GreenhouseCard = memo(GreenhouseCardImpl);
