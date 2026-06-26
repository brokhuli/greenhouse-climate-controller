/**
 * The shared history-window set. One canonical list used by both the detail charts and the
 * fleet-overview card sparklines (each view keeps its own selection); kept tiny and pure so the
 * containers and the picker agree. Values match the platform `window` query-param enum.
 */
export type RangeKey = "15m" | "30m" | "1h" | "6h" | "24h";

export const RANGE_OPTIONS: RangeKey[] = ["15m", "30m", "1h", "6h", "24h"];

const RANGE_MS: Record<RangeKey, number> = {
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

export const rangeMs = (key: RangeKey): number => RANGE_MS[key];

export const isRangeKey = (value: string | null): value is RangeKey =>
  value != null && (RANGE_OPTIONS as string[]).includes(value);
