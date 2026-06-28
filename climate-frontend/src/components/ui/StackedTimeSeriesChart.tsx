import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { alignSeries, type SeriesPoint } from "../../lib/derivations";
import {
  bandFractions,
  bandScale,
  toBandFraction,
  type Band,
  type BandScale,
} from "../../lib/stackedChart";
import { resolveColor } from "../../lib/chartStyle";
import { formatTimestamp } from "../../lib/timeFormat";
import { useTheme } from "../../hooks/theme";
import type { ReferenceLine } from "./TimeSeriesChart";

/**
 * The combined "climate overview" chart (components §3): several metrics drawn in one uPlot canvas
 * as stacked bands sharing a single time axis, a single vertical cursor, and one hover readout that
 * lists every series. Each metric is normalized into its own vertical sub-band of a unitless [0,1]
 * y-scale (see `lib/stackedChart`), so the left axis shows one tick column with per-band scales and
 * the bands never overlap. Like the single-series chart it appends live points via `setData` and
 * degrades to a text summary where canvas isn't available (a11y fallback + jsdom tests).
 */
export type StackedBand = {
  /** Stable identity (the metric key) used for React keys and structure diffing. */
  key: string;
  label: string;
  unit: string;
  color: string;
  points: SeriesPoint[];
  references?: ReferenceLine[];
};

const STACKED_HEIGHT = 400; // mirrors --chart-stacked-height
const BAND_GAP = 0.06; // vertical gap between bands, in y-scale fraction units
const NO_REFERENCES: ReferenceLine[] = [];

const format = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

/** Whether a real 2D canvas context is obtainable (false under jsdom / SSR). */
function hasCanvas2d(): boolean {
  try {
    return Boolean(document.createElement("canvas").getContext("2d"));
  } catch {
    return false;
  }
}

type BandLayout = { band: Band; scale: BandScale };
type BandMeta = { label: string; unit: string; color: string };
type Aligned = { xs: number[]; ys: (number | null)[][] };

/**
 * Multi-row hover readout: a single floating box (time header + one colored row per band, in native
 * units read from the aligned raw values). Pure DOM in `u.over` so it tracks the canvas without a
 * React round-trip; uPlot tears it down with the plot on destroy.
 */
function tooltipPlugin(getBands: () => BandMeta[], getAligned: () => Aligned): uPlot.Plugin {
  let box: HTMLDivElement | null = null;
  let header: HTMLDivElement | null = null;
  let rows: HTMLDivElement | null = null;

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
          padding: "6px 8px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-3)",
          boxShadow: "var(--shadow-md)",
          fontSize: "11px",
          lineHeight: "1.4",
          whiteSpace: "nowrap",
        } satisfies Partial<CSSStyleDeclaration>);

        header = document.createElement("div");
        header.style.color = "var(--color-fg-subtle)";
        header.style.marginBottom = "4px";

        rows = document.createElement("div");
        box.append(header, rows);
        self.over.appendChild(box);
      },
      setCursor: (self) => {
        if (!box || !header || !rows) return;
        const idx = self.cursor.idx;
        const aligned = getAligned();
        const xValue = idx == null ? null : (aligned.xs[idx] ?? null);
        if (idx == null || xValue == null) {
          box.style.display = "none";
          return;
        }

        header.textContent = formatTimestamp(xValue);
        rows.textContent = "";
        let anyRow = false;
        getBands().forEach((meta, bandIndex) => {
          const raw = aligned.ys[bandIndex]?.[idx];
          if (raw == null) return;
          anyRow = true;

          const row = document.createElement("div");
          Object.assign(row.style, {
            display: "flex",
            alignItems: "center",
            gap: "6px",
          } satisfies Partial<CSSStyleDeclaration>);

          const dot = document.createElement("span");
          Object.assign(dot.style, {
            width: "8px",
            height: "8px",
            borderRadius: "9999px",
            background: meta.color,
            flex: "0 0 auto",
          } satisfies Partial<CSSStyleDeclaration>);

          const label = document.createElement("span");
          label.style.color = "var(--color-fg-muted)";
          label.textContent = meta.label;

          const value = document.createElement("span");
          Object.assign(value.style, {
            marginLeft: "auto",
            paddingLeft: "16px",
            fontWeight: "600",
            color: "var(--color-fg-default)",
          } satisfies Partial<CSSStyleDeclaration>);
          value.textContent = `${format(raw)} ${meta.unit}`.trim();

          row.append(dot, label, value);
          rows!.appendChild(row);
        });

        if (!anyRow) {
          box.style.display = "none";
          return;
        }
        box.style.display = "block";

        // Sit beside the cursor, flipping to its left near the right edge so it never clips.
        const overWidth = self.over.clientWidth;
        const boxWidth = box.offsetWidth;
        const cursorLeft = self.valToPos(xValue, "x");
        let left = cursorLeft + 12;
        if (left + boxWidth > overWidth) left = cursorLeft - 12 - boxWidth;
        box.style.left = `${Math.max(0, Math.min(left, overWidth - boxWidth))}px`;
        box.style.top = "8px";
      },
    },
  };
}

export function StackedTimeSeriesChart({
  bands,
  height,
}: {
  bands: StackedBand[];
  height?: number;
}) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const plotHeight = height ?? STACKED_HEIGHT;

  // Per-band vertical placement + native-unit scale. Frozen into the plot at build time (see
  // structureKey): live points stream through setData and are clamped to the band rather than
  // rebuilding the axes on every frame; a range change reshapes the domain and rebuilds.
  const layout = useMemo<BandLayout[]>(() => {
    const fractions = bandFractions(bands.length, BAND_GAP);
    return bands.map((band, index) => {
      const values: number[] = band.points.map((point) => point.v);
      for (const reference of band.references ?? NO_REFERENCES) values.push(reference.value);
      const min = values.length ? Math.min(...values) : 0;
      const max = values.length ? Math.max(...values) : 1;
      return { band: fractions[index], scale: bandScale(min, max) };
    });
  }, [bands]);

  // Shared x axis with null-filled gaps; the tooltip reads native units straight from here.
  const aligned = useMemo<Aligned>(() => alignSeries(bands.map((band) => band.points)), [bands]);

  // Plot rows live in fraction space: one line per band, then each band's dashed references.
  const data = useMemo<uPlot.AlignedData>(() => {
    const lineRows = bands.map((_band, index) => {
      const { band, scale } = layout[index];
      return aligned.ys[index].map((value) =>
        value == null ? null : toBandFraction(value, scale, band),
      );
    });
    const referenceRows: (number | null)[][] = [];
    bands.forEach((band, index) => {
      const layoutForBand = layout[index];
      for (const reference of band.references ?? NO_REFERENCES) {
        const fraction = toBandFraction(reference.value, layoutForBand.scale, layoutForBand.band);
        referenceRows.push(aligned.xs.map(() => fraction));
      }
    });
    return [aligned.xs, ...lineRows, ...referenceRows];
  }, [bands, layout, aligned]);

  const dataRef = useRef(data);
  dataRef.current = data;
  const alignedRef = useRef(aligned);
  alignedRef.current = aligned;
  const buildRef = useRef({ bands, layout, plotHeight });
  buildRef.current = { bands, layout, plotHeight };

  // Recreate the plot only when its *structure* changes — band identity/refs, theme, height, or the
  // rounded per-band domains (which shift on a range change, not as live points stream in).
  const structureKey = JSON.stringify({
    theme,
    plotHeight,
    bands: bands.map((band) => [
      band.key,
      band.label,
      band.color,
      band.unit,
      (band.references ?? NO_REFERENCES).map((reference) => [
        reference.label,
        reference.color ?? null,
      ]),
    ]),
    scales: layout.map((entry) => [
      entry.scale.lo,
      entry.scale.hi,
      entry.scale.ticks,
      entry.band.bottom,
      entry.band.top,
    ]),
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // uPlot needs a real 2D canvas; where one isn't available (jsdom, SSR) skip it and show the
    // text fallback rather than letting uPlot fail mid-draw on a stubbed context.
    if (!hasCanvas2d()) {
      setCanvasReady(false);
      return;
    }
    const { bands, layout, plotHeight } = buildRef.current;
    const width = container.clientWidth || 600;

    const axisStroke = resolveColor("var(--color-fg-muted)");
    const gridStroke = resolveColor("var(--color-divider)");

    // One left tick column: each band's native ticks, mapped into its fraction sub-range. The shared
    // y grid then draws the faint per-band gridlines.
    const splitFractions: number[] = [];
    const labelByFraction = new Map<number, string>();
    for (const entry of layout) {
      for (const tick of entry.scale.ticks) {
        const fraction = toBandFraction(tick, entry.scale, entry.band);
        splitFractions.push(fraction);
        labelByFraction.set(fraction, format(tick));
      }
    }
    splitFractions.sort((a, b) => a - b);

    const seriesConfig: uPlot.Series[] = [{}];
    for (const band of bands) {
      seriesConfig.push({
        label: band.label,
        stroke: resolveColor(band.color),
        width: 1.5,
        points: { show: false },
      });
    }
    for (const band of bands) {
      for (const reference of band.references ?? NO_REFERENCES) {
        seriesConfig.push({
          label: `${band.label} · ${reference.label}`,
          stroke: resolveColor(reference.color ?? "var(--chart-setpoint)"),
          width: 1,
          dash: [4, 4],
          points: { show: false },
        });
      }
    }

    const opts: uPlot.Options = {
      width,
      height: plotHeight,
      legend: { show: false },
      cursor: { x: true, y: false },
      plugins: [
        tooltipPlugin(
          () =>
            buildRef.current.bands.map((band) => ({
              label: band.label,
              unit: band.unit,
              color: band.color,
            })),
          () => alignedRef.current,
        ),
      ],
      scales: { x: { time: true }, y: { range: [0, 1] } },
      padding: [12, 8, 0, 0],
      axes: [
        {
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { show: false },
          border: { show: true, stroke: gridStroke, width: 1 },
        },
        {
          scale: "y",
          side: 3,
          stroke: axisStroke,
          grid: { stroke: gridStroke, width: 1 },
          ticks: { show: false },
          size: 52,
          splits: () => splitFractions,
          values: (_self, splits) => splits.map((split) => labelByFraction.get(split) ?? ""),
          border: { show: true, stroke: gridStroke, width: 1 },
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

  const hasReferences = bands.some((band) => (band.references ?? NO_REFERENCES).length > 0);
  const summary = bands
    .map((band) => {
      const latest = band.points.at(-1)?.v;
      return latest !== undefined
        ? `${band.label}: latest ${format(latest)} ${band.unit}`.trim()
        : `${band.label}: no data in range`;
    })
    .join("; ");

  return (
    <div className="w-full">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        {bands.map((band) => (
          <span key={band.key} className="text-fg-muted flex items-center gap-2 text-xs">
            <span
              className="inline-block h-[2px] w-3 rounded-full"
              style={{ background: band.color }}
            />
            {band.label} ({band.unit})
          </span>
        ))}
        {hasReferences ? (
          <span className="text-fg-muted flex items-center gap-2 text-xs">
            <span
              className="inline-block w-3 border-t border-dashed"
              style={{ borderColor: "var(--chart-setpoint)" }}
            />
            Setpoint / Target
          </span>
        ) : null}
      </div>
      <div ref={containerRef} role="img" aria-label={summary} className="w-full" />
      {!canvasReady ? (
        <p className="text-fg-subtle text-xs" data-testid="chart-fallback">
          {summary}
        </p>
      ) : null}
    </div>
  );
}
