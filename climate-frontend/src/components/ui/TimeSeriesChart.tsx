import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { SeriesPoint } from "../../lib/derivations";

/**
 * The live + historical line chart (components §3), rendered with uPlot's canvas so a moving window
 * redraws without per-point DOM churn (tech-stack §charting). One metric per chart plus optional
 * dashed reference lines (setpoint / min-max); the detail view stacks several. Live points are
 * appended via `setData` without re-instantiating the plot (interactions §4). Degrades to an
 * accessible text summary where canvas isn't available (a11y fallback + jsdom tests).
 */
export type ChartSeries = { label: string; color: string; points: SeriesPoint[] };
export type ReferenceLine = { label: string; value: number; color?: string };
export type ChartVariant = "full" | "sparkline";

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
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const plotHeight = height ?? (variant === "sparkline" ? SPARKLINE_HEIGHT : FULL_HEIGHT);

  // Latest build inputs, read by the (structure-keyed) create effect without widening its deps.
  const buildRef = useRef({ series, references, variant, plotHeight });
  buildRef.current = { series, references, variant, plotHeight };

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
    const width = container.clientWidth || 600;

    const seriesConfig: uPlot.Series[] = [
      {},
      {
        label: series.label,
        stroke: resolveColor(series.color),
        width: 1.5,
        points: { show: false },
      },
      ...references.map<uPlot.Series>((reference) => ({
        label: reference.label,
        stroke: resolveColor(reference.color ?? "var(--color-fg-muted)"),
        width: 1,
        dash: [4, 4],
        points: { show: false },
      })),
    ];

    const axisStroke = resolveColor("var(--color-fg-muted)");
    const gridStroke = resolveColor("var(--color-divider)");
    const opts: uPlot.Options = {
      width,
      height: plotHeight,
      legend: { show: false },
      cursor: { show: !isSparkline },
      scales: { x: { time: true } },
      padding: isSparkline ? [2, 2, 2, 2] : [8, 8, 0, 0],
      axes: isSparkline
        ? [{ show: false }, { show: false }]
        : [
            { stroke: axisStroke, grid: { stroke: gridStroke, width: 1 }, ticks: { show: false } },
            {
              stroke: axisStroke,
              grid: { stroke: gridStroke, width: 1 },
              ticks: { show: false },
              size: 44,
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
