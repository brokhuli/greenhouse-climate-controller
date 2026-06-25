import { memo } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import type { Connectivity, GreenhouseSummary } from "../../api/schemas";
import { liveSeriesKey, useLiveSeries } from "../../hooks/useLiveSeries";
import { mergeReadings } from "../../lib/derivations";
import { MetricTile } from "../../components/ui/MetricTile";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { TimeScaleIndicator } from "../../components/ui/TimeScaleControl";
import { TimeSeriesChart } from "../../components/ui/TimeSeriesChart";

const CHART_HEIGHT = 80;

/**
 * The per-card accent (status dot + trend stroke): connectivity color, with drift taking over an
 * otherwise-online card. Offline and degraded outrank drift since they're the more pressing signal.
 * This intentionally overrides the metric-identity chart color so the trend reads as the card's
 * health at a glance (per the fleet mockup).
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
function GreenhouseCardImpl({ summary }: { summary: GreenhouseSummary }) {
  const live = useLiveSeries(summary.id);
  const points = mergeReadings(live.get(liveSeriesKey("temperature")) ?? [], []);
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

      <div className="grid grid-cols-2 gap-3">
        <MetricTile
          label="Temperature"
          value={summary.climate.temperature}
          setpoint={summary.climate.setpointTemperature}
          unit="°C"
          dim={offline}
        />
        <MetricTile label="Humidity" value={summary.climate.humidity} unit="%" dim={offline} />
      </div>

      <div className="mt-auto">
        {points.length > 0 ? (
          <TimeSeriesChart
            variant="card"
            height={CHART_HEIGHT}
            unit="°C"
            series={{ label: "Temperature", color: accent, points }}
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
