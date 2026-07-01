import { Clock, Droplet } from "lucide-react";
import {
  formatLastWatered,
  formatSchedule,
  formatZoneLabel,
  moistureFillSpans,
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

// The bar fills like a gauge: colour runs from 0 up to the reading only, colouring each threshold band
// (dry / in-target / wet) over the portion the reading covers. Above the reading the bar stays on the
// neutral dark TRACK so it reads as too-dry / in-target / too-wet at a glance. Each fill uses the same
// orange/green/blue chart palette as the stacked climate series at full strength, so the bands match
// the chart lines directly.
const TRACK = "var(--color-surface-3)";
const DRY_FILL = "var(--chart-par)";
const BAND_FILL = "var(--chart-temperature)";
const WET_FILL = "var(--chart-humidity)";
// Section-break tick at each band start: a graduation mark in a mid-tone so it stands out over both
// the coloured fill and the dark track, in either theme.
const TICK = "var(--color-fg-subtle)";

/** The moisture bar: a band-coloured gauge that fills from 0 to the reading, with a droplet on top. */
function MoistureBar({ row }: { row: ZoneMoistureRow }) {
  const status = zoneMoistureStatus({
    moistureVwc: row.moistureVwc,
    lowThreshold: row.lowThreshold,
    highThreshold: row.highThreshold,
    irrigating: row.irrigating,
    faulted: row.faulted,
  });
  const position = moistureScalePosition(row.moistureVwc);
  const spans = moistureFillSpans(row.moistureVwc, row.lowThreshold, row.highThreshold);
  return (
    <div className="flex items-center gap-2">
      <span className="text-fg-default w-9 shrink-0 font-mono text-sm tabular-nums">
        {row.moistureVwc == null ? "—" : `${asPercent(row.moistureVwc)} %`}
      </span>
      <div className="relative h-1.5 min-w-0 flex-1">
        {/* Dark track underneath, then the band-tinted fill up to the reading on top of it. */}
        <div className="absolute inset-0 rounded-full" style={{ backgroundColor: TRACK }} />
        <div className="absolute inset-0 flex overflow-hidden rounded-full">
          <div style={{ width: `${spans.dry * 100}%`, backgroundColor: DRY_FILL }} />
          <div style={{ width: `${spans.target * 100}%`, backgroundColor: BAND_FILL }} />
          <div style={{ width: `${spans.wet * 100}%`, backgroundColor: WET_FILL }} />
        </div>
        {/* Section-break ticks at each band start, protruding past the bar so the thresholds stay
            legible even where the track is dark. */}
        <div
          className="absolute -inset-y-0.5 w-0.5 rounded-full"
          style={{
            left: `${spans.low * 100}%`,
            transform: "translateX(-50%)",
            backgroundColor: TICK,
          }}
        />
        <div
          className="absolute -inset-y-0.5 w-0.5 rounded-full"
          style={{
            left: `${spans.high * 100}%`,
            transform: "translateX(-50%)",
            backgroundColor: TICK,
          }}
        />
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
      <div className="text-fg-muted mt-1 flex items-center gap-2 pt-2 text-sm">
        <Clock size={14} aria-hidden className="shrink-0" />
        <span>
          Irrigation Schedule:{" "}
          <span className="text-fg-default font-mono tabular-nums">{schedules.join("  •  ")}</span>
        </span>
      </div>
    </div>
  );
}
