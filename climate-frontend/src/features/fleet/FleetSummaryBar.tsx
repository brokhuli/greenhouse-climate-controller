import { Activity, Ban, CircleCheck, Target, TriangleAlert, type LucideIcon } from "lucide-react";
import type { StatusRollup } from "../../lib/derivations";

const GRID_STYLE = { gap: "var(--layout-card-gap)" };

/**
 * One site-level rollup card (components §2): a tinted circular Lucide icon beside the label, a
 * large default-foreground number, and a short caption — the status color lives in the icon badge
 * (and the optional caption dot), never the number. `color` is a status token; the badge fill is
 * derived from it with color-mix so a tile owns just one color value.
 */
function Stat({
  label,
  value,
  caption,
  Icon,
  color,
  dot = false,
}: {
  label: string;
  value: number;
  caption: string;
  Icon: LucideIcon;
  color: string;
  dot?: boolean;
}) {
  return (
    <div className="border-border bg-surface-1 flex items-center gap-3 rounded-lg border p-4">
      <span
        className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
        aria-hidden
      >
        <Icon size={30} />
      </span>
      <div className="min-w-0">
        <p className="section-label">{label}</p>
        <p className="text-fg-default font-mono text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-fg-subtle mt-0.5 flex items-center gap-1.5 text-xs">
          {dot ? (
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
              aria-hidden
            />
          ) : null}
          {caption}
        </p>
      </div>
    </div>
  );
}

/**
 * Site-level rollup bar (components §2): total greenhouses, healthy, attention needed, offline, and
 * drift. Fits five across on wide desktop before wrapping.
 */
export function FleetSummaryBar({ rollup }: { rollup: StatusRollup }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" style={GRID_STYLE}>
      <Stat
        label="Total Greenhouses"
        value={rollup.total}
        caption="All sites"
        Icon={Activity}
        color="var(--chart-temperature)"
      />
      <Stat
        label="Healthy"
        value={rollup.online}
        caption="Reporting normally"
        Icon={CircleCheck}
        color="var(--chart-temperature)"
      />
      <Stat
        label="Attention Needed"
        value={rollup.degraded}
        caption="Degraded"
        dot
        Icon={TriangleAlert}
        color="var(--color-status-degraded)"
      />
      <Stat
        label="Offline"
        value={rollup.offline}
        caption="No data"
        Icon={Ban}
        color="var(--color-status-offline)"
      />
      <Stat
        label="Drift Detected"
        value={rollup.drift}
        caption="Setpoints mismatched"
        dot
        Icon={Target}
        color="var(--color-status-drift)"
      />
    </div>
  );
}
