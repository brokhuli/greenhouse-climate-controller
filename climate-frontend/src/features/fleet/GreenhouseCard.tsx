import { memo } from "react";
import { Link } from "react-router-dom";
import type { GreenhouseSummary } from "../../api/schemas";
import { liveSeriesKey, useLiveSeries } from "../../hooks/useLiveSeries";
import { mergeReadings } from "../../lib/derivations";
import { MetricTile } from "../../components/ui/MetricTile";
import { Pill } from "../../components/ui/Pill";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { TimeScaleIndicator } from "../../components/ui/TimeScaleControl";
import { TimeSeriesChart } from "../../components/ui/TimeSeriesChart";

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

  return (
    <Link
      to={`/greenhouses/${summary.id}`}
      className={`border-border bg-surface-1 hover:border-border-strong flex flex-col gap-3 rounded-lg border p-4 transition-colors duration-[var(--motion-instant)] ${
        offline ? "opacity-70" : ""
      }`}
      style={{ minHeight: 168 }}
    >
      <div className="flex items-center justify-between gap-2">
        <StatusBadge status={summary.status} drift={summary.drift} />
        {showSpeed && summary.timeScale != null ? (
          <TimeScaleIndicator scale={summary.timeScale} />
        ) : null}
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <span className="text-fg-default truncate text-base font-semibold">
          {summary.displayName}
        </span>
        {summary.crop ? <Pill>{summary.crop}</Pill> : null}
      </div>

      <MetricTile
        label="Temperature"
        value={summary.climate.temperature}
        setpoint={summary.climate.setpointTemperature}
        unit="°C"
        dim={offline}
      />

      <div className="mt-auto">
        {points.length > 0 ? (
          <TimeSeriesChart
            variant="sparkline"
            unit="°C"
            series={{ label: "Temperature", color: "var(--chart-temperature)", points }}
          />
        ) : (
          <div className="text-fg-subtle flex items-center text-xs" style={{ height: 40 }}>
            {offline ? "offline — no live data" : "awaiting telemetry…"}
          </div>
        )}
      </div>
    </Link>
  );
}

export const GreenhouseCard = memo(GreenhouseCardImpl);
