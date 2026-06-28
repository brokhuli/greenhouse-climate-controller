import type uPlot from "uplot";
import { withAlpha } from "./color";

/**
 * uPlot canvas-style glue shared by the chart components. Kept out of any single component file so
 * the line chart and the stacked chart resolve colors / build fills the same way (and so component
 * files keep fast-refresh's single-export-per-file constraint).
 */

const FALLBACK_COLOR = "#888888";

/** Resolve a leaf `var(--token)` to its computed value (uPlot strokes are canvas colors, not CSS). */
export function resolveColor(value: string): string {
  const match = value.match(/^var\((--[\w-]+)\)$/);
  if (!match) return value;
  if (typeof getComputedStyle === "undefined") return FALLBACK_COLOR;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
  return resolved || FALLBACK_COLOR;
}

/** Faint accent tint under a series line, fading to transparent at the baseline. */
export function areaFill(color: string): uPlot.Series.Fill {
  return (self) => {
    const { ctx, bbox } = self;
    const gradient = ctx.createLinearGradient(0, bbox.top, 0, bbox.top + bbox.height);
    gradient.addColorStop(0, withAlpha(color, 0.2));
    gradient.addColorStop(1, withAlpha(color, 0));
    return gradient;
  };
}
