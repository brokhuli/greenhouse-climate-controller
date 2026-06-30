import { Clock, Droplet } from "lucide-react";
import {
  formatLastWatered,
  formatSchedule,
  formatZoneLabel,
  moistureScalePosition,
  zoneMoistureStatus,
} from "../../lib/derivations";

/**
 * One zone's soil-moisture row data (components §3). Presentational: the detail view resolves the
 * current `moistureVwc` (live edge over the snapshot) and the live status fields; this panel turns
 * them into the per-zone status table — moisture-in-band slider, target range, last-watered, and a
 * single headline status — with the shared irrigation schedule in the footer.
 */
export type ZoneMoistureRow = {
  zoneId: string;
  moistureVwc: number | null;
  lowThreshold: number;
  highThreshold: number;
  lastWatered: Date | null;
  irrigating: boolean;
  faulted: boolean;
  schedule: string;
};

// Header and every data row share one column template so the table aligns.
const GRID = "grid items-center gap-x-3";
const GRID_STYLE = {
  gridTemplateColumns: "minmax(3.5rem,0.9fr) minmax(8rem,1.5fr) auto auto auto",
};

const asPercent = (vwc: number): number => Math.round(vwc * 100);
const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

// The bar spans the full 0–100% VWC scale, split into three regions at the thresholds so a reading
// reads as too-dry / in-target / too-wet at a glance. Each segment blends its semantic colour into
// the neutral track so the bar stays cohesive.
const DRY_FILL = "color-mix(in srgb, var(--color-warning) 18%, var(--color-surface-3))";
const BAND_FILL = "color-mix(in srgb, var(--color-status-online) 40%, var(--color-surface-3))";
const WET_FILL = "color-mix(in srgb, var(--color-info) 18%, var(--color-surface-3))";

/** The moisture bar: three threshold regions across the 0–100% scale with a droplet at the reading. */
function MoistureBar({ row }: { row: ZoneMoistureRow }) {
  const status = zoneMoistureStatus({
    moistureVwc: row.moistureVwc,
    lowThreshold: row.lowThreshold,
    highThreshold: row.highThreshold,
    irrigating: row.irrigating,
    faulted: row.faulted,
  });
  const position = moistureScalePosition(row.moistureVwc);
  const low = clamp01(row.lowThreshold);
  const high = Math.max(low, clamp01(row.highThreshold));
  return (
    <div className="flex items-center gap-2">
      <span className="text-fg-default w-9 shrink-0 font-mono text-sm tabular-nums">
        {row.moistureVwc == null ? "—" : `${asPercent(row.moistureVwc)} %`}
      </span>
      <div className="relative h-1.5 min-w-0 flex-1">
        <div className="absolute inset-0 flex overflow-hidden rounded-full">
          <div style={{ width: `${low * 100}%`, backgroundColor: DRY_FILL }} />
          <div style={{ width: `${(high - low) * 100}%`, backgroundColor: BAND_FILL }} />
          <div className="flex-1" style={{ backgroundColor: WET_FILL }} />
        </div>
        {position != null ? (
          <Droplet
            size={14}
            aria-hidden
            className="absolute top-1/2"
            style={{
              left: `${position * 100}%`,
              transform: "translate(-50%, -50%)",
              color: `var(${status.colorVar})`,
              fill: "var(--color-surface-1)",
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

export function ZoneMoisturePanel({ rows }: { rows: ZoneMoistureRow[] }) {
  if (rows.length === 0) {
    return <p className="text-fg-subtle text-sm">No irrigation zones configured.</p>;
  }

  // The schedule is per-zone but usually shared; collapse to the distinct set for the footer.
  const schedules = [...new Set(rows.map((row) => formatSchedule(row.schedule)))];

  return (
    <div className="flex flex-col">
      <div className={`${GRID} section-label py-1`} style={GRID_STYLE}>
        <span>Zone</span>
        <span>Moisture</span>
        <span>Target Range</span>
        <span>Last Watered</span>
        <span>Status</span>
      </div>
      {rows.map((row) => {
        const status = zoneMoistureStatus({
          moistureVwc: row.moistureVwc,
          lowThreshold: row.lowThreshold,
          highThreshold: row.highThreshold,
          irrigating: row.irrigating,
          faulted: row.faulted,
        });
        return (
          <div
            key={row.zoneId}
            className={`${GRID} border-divider border-b py-2 last:border-b-0`}
            style={GRID_STYLE}
          >
            <span className="text-fg-default min-w-0 truncate text-sm font-medium">
              {formatZoneLabel(row.zoneId)}
            </span>
            <MoistureBar row={row} />
            <span className="text-fg-muted font-mono text-sm tabular-nums">
              {asPercent(row.lowThreshold)} – {asPercent(row.highThreshold)} %
            </span>
            <span className="text-fg-muted text-sm">{formatLastWatered(row.lastWatered)}</span>
            <span className="text-sm font-medium" style={{ color: `var(${status.colorVar})` }}>
              {status.label}
            </span>
          </div>
        );
      })}
      <div className="border-divider text-fg-muted mt-1 flex items-center gap-2 border-t pt-2 text-sm">
        <Clock size={14} aria-hidden className="shrink-0" />
        <span>
          Irrigation Schedule:{" "}
          <span className="text-fg-default font-mono tabular-nums">{schedules.join("  •  ")}</span>
        </span>
      </div>
    </div>
  );
}
