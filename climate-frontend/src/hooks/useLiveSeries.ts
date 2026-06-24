import { useCallback, useEffect, useRef, useState } from "react";
import type { Metric, Reading, TelemetryFrame } from "../api/schemas";
import { useStream } from "../app/stream-context";

/**
 * Per-series live ring buffer for the visible chart window (architecture §4 "WS carries the live
 * edge"). Subscribes to the single stream, keeps the last `capacity` readings for each
 * metric+zone of one greenhouse, and coalesces bursts into one state update per animation frame so
 * an accelerated simulation can't outrun the renderer (interactions §4).
 *
 * Keyed by `liveSeriesKey(metric, zoneId)` so house metrics and per-zone soil moisture stay
 * distinct; the historical half (per-zone) comes from `useTelemetry`.
 */
export type LiveSeriesKey = string;
export type LiveSeries = ReadonlyMap<LiveSeriesKey, readonly Reading[]>;

/** `temperature` for a house metric, `soil_moisture:bench-a` for a zone-scoped one. */
export function liveSeriesKey(metric: Metric, zoneId: string | null = null): LiveSeriesKey {
  return zoneId ? `${metric}:${zoneId}` : metric;
}

const DEFAULT_CAPACITY = 600; // ~10 min at 1 Hz

export function useLiveSeries(greenhouseId: string, capacity = DEFAULT_CAPACITY): LiveSeries {
  const { subscribeTelemetry } = useStream();
  const buffers = useRef(new Map<LiveSeriesKey, Reading[]>());
  const rafId = useRef<number | null>(null);
  const [series, setSeries] = useState<LiveSeries>(() => new Map());

  const flush = useCallback(() => {
    rafId.current = null;
    const snapshot = new Map<LiveSeriesKey, readonly Reading[]>();
    for (const [key, readings] of buffers.current) snapshot.set(key, readings.slice());
    setSeries(snapshot);
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafId.current !== null) return;
    if (typeof requestAnimationFrame === "function") {
      rafId.current = requestAnimationFrame(flush);
    } else {
      flush();
    }
  }, [flush]);

  useEffect(() => {
    buffers.current = new Map();
    setSeries(new Map());

    const unsubscribe = subscribeTelemetry((frame: TelemetryFrame) => {
      if (frame.greenhouse_id !== greenhouseId) return;
      const ts = new Date(frame.ts);
      for (const reading of frame.readings) {
        const key = liveSeriesKey(reading.metric, frame.zone_id);
        const buffer = buffers.current.get(key) ?? [];
        buffer.push({ value: reading.value, ts });
        if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
        buffers.current.set(key, buffer);
      }
      scheduleFlush();
    });

    return () => {
      unsubscribe();
      if (rafId.current !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId.current);
      }
      rafId.current = null;
    };
  }, [greenhouseId, capacity, subscribeTelemetry, scheduleFlush]);

  return series;
}
