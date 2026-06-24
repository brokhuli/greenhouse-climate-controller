/** Detail-view history windows. Kept tiny and pure so the container and the picker agree. */
export type RangeKey = "1h" | "6h" | "24h" | "7d";

export const RANGE_OPTIONS: RangeKey[] = ["1h", "6h", "24h", "7d"];

const RANGE_MS: Record<RangeKey, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export const rangeMs = (key: RangeKey): number => RANGE_MS[key];

export const isRangeKey = (value: string | null): value is RangeKey =>
  value != null && (RANGE_OPTIONS as string[]).includes(value);
