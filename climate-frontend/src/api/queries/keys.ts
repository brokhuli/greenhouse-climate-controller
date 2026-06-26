import type { AnalyticsInterval, EventKind, EventSeverity } from "../schemas";

/** A history-query window. The server resolves it against the greenhouse's latest stored timestamp. */
export type RangeParams = { window: string };

/** Activity-feed filter; all fields optional (data-model §6 `["events", scope]`). */
export type EventScope = { greenhouseId?: string; kind?: EventKind; severity?: EventSeverity };

/**
 * The hierarchical query-key scheme (data-model spec §6). Keys are stable so WebSocket frames
 * and mutations can target the right cache entries.
 */
export const queryKeys = {
  fleet: () => ["fleet"] as const,
  greenhouse: (id: string) => ["greenhouse", id] as const,
  fleetSparklines: (window: string) => ["fleet-sparklines", window] as const,
  telemetry: (id: string, range: RangeParams) => ["telemetry", id, range.window] as const,
  analytics: (id: string, range: RangeParams, interval: AnalyticsInterval) =>
    ["analytics", id, range.window, interval] as const,
  events: (scope: EventScope) => ["events", scope] as const,
};
