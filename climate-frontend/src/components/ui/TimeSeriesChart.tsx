import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { SeriesPoint } from "../../lib/derivations";
import { withAlpha } from "../../lib/color";
import { wholeNumberBounds } from "../../lib/chartScale";
import { formatClockSeconds, formatClockTime, formatTimestamp } from "../../lib/timeFormat";
import { useTheme } from "../../hooks/theme";

/**
 * The live + historical line chart (components §3), rendered with uPlot's canvas so a moving window
 * redraws without per-point DOM churn (tech-stack §charting). One metric per chart plus optional
 * dashed reference lines (setpoint / min-max); the detail view stacks several. Live points are
 * appended via `setData` without re-instantiating the plot (interactions §4). Degrades to an
 * accessible text summary where canvas isn't available (a11y fallback + jsdom tests).
 */
export type ChartSeries = { label: string; color: string; points: SeriesPoint[] };
export type ReferenceLine = { label: string; value: number; color?: string };
export type ChartVariant = "full" | "sparkline" | "card";

const FULL_HEIGHT = 180;
const SPARKLINE_HEIGHT = 40;
const FALLBACK_COLOR = "#888888";
const NO_REFERENCES: ReferenceLine[] = [];

/** Resolve a leaf `var(--token)` to its computed value (uPlot strokes are canvas colors, not CSS). */
function resolveColor(value: string): string {
  const match = value.match(/^var\((--[\w-]+)\)$/);
  if (!match) return value;
  if (typeof getComputedStyle === "undefined") return FALLBACK_COLOR;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
  return resolved || FALLBACK_COLOR;
}

const format = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

/** Faint accent tint under a series line, fading to transparent at the baseline. */
function areaFill(color: string): uPlot.Series.Fill {
  return (self) => {
    const { ctx, bbox } = self;
    const gradient = ctx.createLinearGradient(0, bbox.top, 0, bbox.top + bbox.height);
    gradient.addColorStop(0, withAlpha(color, 0.2));
    gradient.addColorStop(1, withAlpha(color, 0));
    return gradient;
  };
}

/**
 * Floating hover readout: a small box pinned to the focused point showing its value and time (the
 * bare cursor crosshair shows *where* but not *what*). `formatTime` lets each variant choose its
 * precision (live card → HH:MM:SS; detail → date + time). Pure DOM in `u.over` so it tracks the
 * canvas without a React round-trip; uPlot tears it down with the plot on destroy.
 */
function tooltipPlugin(
  getUnit: () => string,
  formatTime: (epochSeconds: number) => string,
): uPlot.Plugin {
  let box: HTMLDivElement | null = null;
  let valueLine: HTMLDivElement | null = null;
  let timeLine: HTMLDivElement | null = null;

  return {
    hooks: {
      init: (self) => {
        box = document.createElement("div");
        Object.assign(box.style, {
          position: "absolute",
          top: "0",
          left: "0",
          pointerEvents: "none",
          zIndex: "10",
          display: "none",
          padding: "4px 6px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-3)",
          boxShadow: "var(--shadow-md)",
          fontSize: "11px",
          lineHeight: "1.3",
          whiteSpace: "nowrap",
        } satisfies Partial<CSSStyleDeclaration>);

        valueLine = document.createElement("div");
        valueLine.style.color = "var(--color-fg-default)";
        valueLine.style.fontWeight = "600";

        timeLine = document.createElement("div");
        timeLine.style.color = "var(--color-fg-subtle)";

        box.append(valueLine, timeLine);
        self.over.appendChild(box);
      },
      setCursor: (self) => {
        if (!box || !valueLine || !timeLine) return;
        const idx = self.cursor.idx;
        const xValue = idx == null ? null : (self.data[0][idx] ?? null);
        const yValue = idx == null ? null : (self.data[1][idx] ?? null);
        if (xValue == null || yValue == null) {
          box.style.display = "none";
          return;
        }

        valueLine.textContent = `${format(yValue)} ${getUnit()}`.trim();
        timeLine.textContent = formatTime(xValue);
        box.style.display = "block";

        const overWidth = self.over.clientWidth;
        const halfWidth = box.offsetWidth / 2;
        const left = Math.max(
          halfWidth,
          Math.min(self.valToPos(xValue, "x"), overWidth - halfWidth),
        );
        const top = self.valToPos(yValue, "y");
        // Always sit above the point so the box is never beneath the cursor. `.u-over` doesn't clip,
        // so near the top edge it simply floats up over the card rather than flipping under.
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        box.style.transform = "translate(-50%, calc(-100% - 12px))";
      },
    },
  };
}

export function TimeSeriesChart({
  series,
  references = NO_REFERENCES,
  variant = "full",
  height,
  unit = "",
}: {
  series: ChartSeries;
  references?: ReferenceLine[];
  variant?: ChartVariant;
  height?: number;
  unit?: string;
}) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const plotHeight = height ?? (variant === "sparkline" ? SPARKLINE_HEIGHT : FULL_HEIGHT);

  // Latest build inputs, read by the (structure-keyed) create effect without widening its deps.
  const buildRef = useRef({ series, references, variant, plotHeight, unit });
  buildRef.current = { series, references, variant, plotHeight, unit };

  const data = useMemo<uPlot.AlignedData>(() => {
    const xs = series.points.map((point) => point.t);
    const ys = series.points.map((point) => point.v);
    const referenceRows = references.map((reference) => xs.map(() => reference.value));
    return [xs, ys, ...referenceRows];
  }, [series.points, references]);

  const dataRef = useRef(data);
  dataRef.current = data;

  // Recreate the plot only when its *structure* changes (variant/height/series/refs config), not
  // when points stream in — those go through setData below.
  const structureKey = JSON.stringify({
    theme,
    variant,
    plotHeight,
    seriesLabel: series.label,
    seriesColor: series.color,
    references: references.map((reference) => [reference.label, reference.color ?? null]),
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { series, references, variant, plotHeight } = buildRef.current;
    const isSparkline = variant === "sparkline";
    const isCard = variant === "card";
    const width = container.clientWidth || 600;

    const strokeColor = resolveColor(series.color);
    const seriesConfig: uPlot.Series[] = [
      {},
      {
        label: series.label,
        stroke: strokeColor,
        width: 1.5,
        points: { show: false },
        // A faint tint under the line on every variant, including the bare sparkline (its subtle glow
        // in the fleet cards).
        fill: areaFill(strokeColor),
      },
      ...references.map<uPlot.Series>((reference) => ({
        label: reference.label,
        stroke: resolveColor(reference.color ?? "var(--color-fg-muted)"),
        width: 1,
        dash: [4, 4],
        points: { show: false },
      })),
    ];

    const axisStroke = resolveColor(isCard ? "var(--color-fg-subtle)" : "var(--color-fg-muted)");
    const gridStroke = resolveColor(isCard ? "var(--color-border)" : "var(--color-divider)");
    // Frame the plot area (left + bottom axis lines) to match the metric tiles' border exactly:
    // same token (--color-border) and 1px weight (Tailwind `border`). Sparkline stays bare.
    const axisBorder: uPlot.Axis.Border | undefined = isSparkline
      ? undefined
      : {
          show: true,
          stroke: resolveColor(isCard ? "var(--color-border)" : "var(--color-divider)"),
          width: 1,
        };
    const padding: uPlot.Padding = isSparkline
      ? [2, 2, 2, 2]
      : isCard
        ? // Top padding clears the topmost y-axis label (its upper half overflows the plot area);
          // 4px clipped it, so match the detail view's proven 8px.
          [8, 0, 0, 0]
        : [8, 8, 0, 0];
    const opts: uPlot.Options = {
      width,
      height: plotHeight,
      legend: { show: false },
      cursor: { show: !isSparkline },
      plugins: isSparkline
        ? undefined
        : [
            tooltipPlugin(
              () => buildRef.current.unit,
              isCard ? formatClockSeconds : formatTimestamp,
            ),
          ],
      scales: {
        x: { time: true },
        // Card y-axis allows only integer ticks; snap the range out to whole-number bounds so at
        // least the min/max labels always render even when the data sits between two integers.
        ...(isCard ? { y: { range: (_u, min, max) => wholeNumberBounds(min, max) } } : {}),
      },
      padding,
      axes: isSparkline
        ? [{ show: false }, { show: false }]
        : [
            {
              // Only the card overrides the x-axis size; the detail view keeps uPlot's default
              // (passing `size: undefined` would collapse the axis and hide the time labels).
              ...(isCard ? { size: 24 } : {}),
              stroke: axisStroke,
              grid: { stroke: gridStroke, width: 1 },
              ticks: { show: false },
              border: axisBorder,
              // Fixed "HH:MM" ticks for the card's short live window (the detail view keeps
              // uPlot's range-adaptive labels).
              ...(isCard ? { values: (_self, splits) => splits.map(formatClockTime) } : {}),
            },
            {
              stroke: axisStroke,
              grid: { stroke: gridStroke, width: 1 },
              ticks: { show: false },
              size: isCard ? 30 : 44,
              border: axisBorder,
              // Integer increments → whole-number labels (the card only charts °C; the detail
              // view keeps uPlot's default increments for its fractional metrics).
              ...(isCard ? { incrs: [1, 2, 5, 10, 20, 50, 100] } : {}),
            },
          ],
      series: seriesConfig,
    };

    let chart: uPlot | null = null;
    try {
      chart = new uPlot(opts, dataRef.current, container);
    } catch {
      // jsdom / no-canvas: fall back to the text summary below.
      setCanvasReady(false);
      return;
    }
    chartRef.current = chart;
    setCanvasReady(true);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        chart?.setSize({ width: container.clientWidth || width, height: plotHeight });
      });
      observer.observe(container);
    }

    return () => {
      observer?.disconnect();
      chart?.destroy();
      chartRef.current = null;
    };
  }, [structureKey]);

  useEffect(() => {
    chartRef.current?.setData(data);
  }, [data]);

  const latest = series.points.at(-1)?.v;
  const summary =
    latest !== undefined
      ? `${series.label}: latest ${format(latest)} ${unit}`.trim()
      : `${series.label}: no data in range`;

  return (
    <div className="w-full">
      <div ref={containerRef} role="img" aria-label={summary} className="w-full" />
      {!canvasReady ? (
        <p className="text-fg-subtle text-xs" data-testid="chart-fallback">
          {summary}
        </p>
      ) : null}
    </div>
  );
}
