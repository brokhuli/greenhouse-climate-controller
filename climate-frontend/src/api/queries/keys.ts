import type { AnalyticsInterval, EventKind, EventSeverity } from "../schemas";

/** ISO 8601 range bounds for a history query (from ≤ to). */
export type RangeParams = { from: string; to: string };

/** Activity-feed filter; all fields optional (data-model §6 `["events", scope]`). */
export type EventScope = { greenhouseId?: string; kind?: EventKind; severity?: EventSeverity };

/**
 * The hierarchical query-key scheme (data-model spec §6). Keys are stable so WebSocket frames
 * and mutations can target the right cache entries.
 */
export const queryKeys = {
  fleet: () => ["fleet"] as const,
  greenhouse: (id: string) => ["greenhouse", id] as const,
  telemetry: (id: string, range: RangeParams) => ["telemetry", id, range.from, range.to] as const,
  analytics: (id: string, range: RangeParams, interval: AnalyticsInterval) =>
    ["analytics", id, range.from, range.to, interval] as const,
  events: (scope: EventScope) => ["events", scope] as const,
};
