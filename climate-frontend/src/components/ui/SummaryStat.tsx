import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

type SummaryStatDensity = "default" | "compact";

const DENSITY_STYLES: Record<
  SummaryStatDensity,
  { card: string; badge: string; iconSize: number }
> = {
  default: {
    card: "gap-3 p-4",
    badge: "h-12 w-12",
    iconSize: 30,
  },
  compact: {
    card: "gap-2.5 p-3",
    badge: "h-9 w-9",
    iconSize: 22,
  },
};

/**
 * One rollup/summary tile (components §2): a tinted circular Lucide icon beside the label, a large
 * default-foreground value, and a short caption — the status color lives in the icon badge (and the
 * optional caption dot), never the value. `color` is a status/metric token; the badge fill is
 * derived from it with color-mix so a tile owns just one color value.
 */
export function SummaryStat({
  label,
  value,
  caption,
  Icon,
  color,
  dot = false,
  density = "default",
}: {
  label: string;
  value: ReactNode;
  caption: ReactNode;
  Icon: LucideIcon;
  color: string;
  dot?: boolean;
  density?: SummaryStatDensity;
}) {
  const styles = DENSITY_STYLES[density];

  return (
    <div
      className={`border-border bg-surface-1 flex items-center rounded-lg border ${styles.card}`}
    >
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full ${styles.badge}`}
        style={{ backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
        aria-hidden
      >
        <Icon size={styles.iconSize} />
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
