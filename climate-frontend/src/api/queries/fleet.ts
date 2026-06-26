import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../client";
import { toFleetSparklines, wireFleetSparklines } from "../schemas";
import { queryKeys } from "./keys";

/** How often the batched history is refreshed so the trailing edge stays current (live covers the gap between refreshes). */
const FLEET_CARD_REFRESH_MS = 60 * 1000;

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
 */
export function useFleetSparklines(window: string) {
  return useQuery({
    queryKey: queryKeys.fleetSparklines(window),
    queryFn: async () =>
      toFleetSparklines(
        await apiClient.get(`/greenhouses/sparklines${query({ window })}`, wireFleetSparklines),
      ),
    refetchInterval: FLEET_CARD_REFRESH_MS,
  });
}
