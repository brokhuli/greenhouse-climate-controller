import { memo } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import type { Connectivity, GreenhouseSummary, Metric } from "../../api/schemas";
import { CARD_METRICS } from "../../api/queries/fleet";
import { liveSeriesKey, useLiveSeries } from "../../hooks/useLiveSeries";
import { latestValue, mergeReadings } from "../../lib/derivations";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { TimeScaleIndicator } from "../../components/ui/TimeScaleControl";
import { MetricSparklineRow } from "./MetricSparklineRow";
import { type MetricHistory } from "./fleetHistory";

/** Card-friendly label + unit per metric (the canonical METRIC_UNIT keeps %RH / µmol·m⁻²·s⁻¹). */
const METRIC_DISPLAY: Record<Metric, { label: string; unit: string }> = {
  temperature: { label: "Temperature", unit: "°C" },
  humidity: { label: "Humidity", unit: "%" },
  co2: { label: "CO₂", unit: "ppm" },
  par: { label: "PAR", unit: "µmol/m²/s" },
  vpd: { label: "VPD", unit: "kPa" },
  soil_moisture: { label: "Soil moisture", unit: "VWC" },
};

/** While every metric reads in-range the sparkline is green; out-of-range banding is wired later. */
const IN_RANGE_COLOR = "var(--color-status-online)";

const NO_HISTORY: MetricHistory = new Map();

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
 * One greenhouse in the fleet grid (components §2): four metrics, each on its own line as
 * `name value unit  ┄sparkline┄`. The whole card links to the detail view; an offline greenhouse
 * mutes without changing the card's anatomy (stable min-height so the grid doesn't reflow). Each
 * row merges the batched REST seed with the live WebSocket tail for its metric, and shows that
 * merged series' latest point as the current value. Memoized so a frame for greenhouse B doesn't
 * re-render greenhouse A's card.
 */
function GreenhouseCardImpl({
  summary,
  history = NO_HISTORY,
  windowMs,
}: {
  summary: GreenhouseSummary;
  history?: MetricHistory;
  /** Visible span (ms), from the fleet range picker — keeps the merge bound matched to the fetched window. */
  windowMs: number;
}) {
  const live = useLiveSeries(summary.id);
  const offline = summary.status === "offline";
  const showSpeed = summary.timeScale != null && summary.timeScale !== 1;
  const accent = accentColor(summary.status, summary.drift);

  return (
    <Link
      to={`/greenhouses/${summary.id}`}
      className={`border-border bg-surface-1 hover:border-border-strong flex flex-col gap-3 rounded-lg border px-3 pt-3 pb-3 transition-colors duration-[var(--motion-instant)] ${
        offline ? "opacity-70" : ""
      }`}
      style={{ minHeight: 240 }}
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

      <div className="mt-auto flex flex-col gap-3">
        {CARD_METRICS.map((metric) => {
          // History (batched REST seed) is the base; the live WebSocket tail wins on timestamp collisions.
          const points = mergeReadings(
            history.get(metric) ?? [],
            live.get(liveSeriesKey(metric)) ?? [],
            { windowMs },
          );
          const display = METRIC_DISPLAY[metric];
          return (
            <MetricSparklineRow
              key={metric}
              label={display.label}
              value={offline ? null : latestValue(points)}
              unit={display.unit}
              points={offline ? [] : points}
              color={IN_RANGE_COLOR}
              offline={offline}
            />
          );
        })}
      </div>
    </Link>
  );
}

export const GreenhouseCard = memo(GreenhouseCardImpl);
