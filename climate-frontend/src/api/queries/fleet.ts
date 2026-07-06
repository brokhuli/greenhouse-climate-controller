import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../client";
import { toFleetSparklines, wireFleetSparklines } from "../schemas";
import type { WsConnectionState } from "../ws";
import { useStream } from "../../app/stream-context";
import { queryKeys } from "./keys";

/** Healthy cadence: refresh the batched history so the trailing edge stays current (live covers the gap between refreshes). */
export const FLEET_POLL_BASE_MS = 60 * 1000;
/** After the first failure, or while the live stream is degraded (slow-fallback floor). */
const FLEET_POLL_STEP_2_MS = 2 * 60 * 1000;
/** After repeated failures — back off hard so a struggling platform isn't hammered. */
const FLEET_POLL_STEP_3_MS = 5 * 60 * 1000;

export type FleetPollSignal = { streamDegraded: boolean; consecutiveFailures: number };

/**
 * The fleet poll's dynamic interval. Escalates 60s → 2m → 5m as consecutive fetches fail so the
 * browser stops amplifying load on an overloaded platform, and floors at 2m whenever the live
 * stream is degraded (slow fallback — never disabled, so cards keep refreshing instead of freezing).
 */
export function fleetPollIntervalMs({
  streamDegraded,
  consecutiveFailures,
}: FleetPollSignal): number {
  const escalated =
    consecutiveFailures >= 2
      ? FLEET_POLL_STEP_3_MS
      : consecutiveFailures === 1
        ? FLEET_POLL_STEP_2_MS
        : FLEET_POLL_BASE_MS;
  return streamDegraded ? Math.max(escalated, FLEET_POLL_STEP_2_MS) : escalated;
}

/**
 * Whether the live stream should be treated as degraded for the fleet poll/indicator. A
 * reconnecting/closed socket usually means the platform is struggling; a plain "connecting" is a
 * normal cold-start handshake, so it isn't treated as degraded.
 */
export function isStreamDegraded(connectionState: WsConnectionState): boolean {
  return connectionState === "reconnecting" || connectionState === "closed";
}

/** The fleet's view-level staleness message, or null when the data can be trusted as live. */
export function fleetStaleNotice(streamDegraded: boolean, isError: boolean): string | null {
  if (isError) return "Couldn't refresh charts — showing the last known data.";
  if (streamDegraded) return "Live stream degraded — charts may be stale.";
  return null;
}

const query = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
};

/**
 * Batched recent history for the whole fleet over the selected `window` — one request that seeds
 * every card's chart and refreshes on an interval so the trailing edge rolls forward, then merged
 * with each card's live WebSocket tail. One request instead of one telemetry call per card (avoids
 * an N+1 across the fleet). The key includes `window`, so changing the range refetches/re-buckets;
 * within a window the key is stable, so the refresh swaps data in place without flicker.
 *
 * The refresh cadence is conditional (`fleetPollIntervalMs`): it backs off on repeated failures and
 * while the live stream is degraded, so the browser doesn't amplify load on a struggling platform.
 */
export function useFleetSparklines(window: string) {
  const { connectionState } = useStream();
  const streamDegraded = isStreamDegraded(connectionState);

  // query-core resets `fetchFailureCount` at the start of every fetch, so it can't count failures
  // across separate poll cycles — track the consecutive tally ourselves (reset on any success).
  const failuresRef = useRef(0);

  const result = useQuery({
    queryKey: queryKeys.fleetSparklines(window),
    queryFn: async () =>
      toFleetSparklines(
        await apiClient.get(`/greenhouses/sparklines${query({ window })}`, wireFleetSparklines),
      ),
    // Don't stack the global network retry under the poll loop — one failed poll = one failure.
    retry: false,
    refetchInterval: () =>
      fleetPollIntervalMs({ streamDegraded, consecutiveFailures: failuresRef.current }),
  });

  // `errorUpdatedAt`/`dataUpdatedAt` each advance once per settled fetch, so this runs exactly once
  // per poll: bump the tally on failure, clear it on success. Read live by `refetchInterval` above.
  useEffect(() => {
    if (result.isError) failuresRef.current += 1;
    else if (result.isSuccess) failuresRef.current = 0;
  }, [result.isError, result.isSuccess, result.errorUpdatedAt, result.dataUpdatedAt]);

  return result;
}
