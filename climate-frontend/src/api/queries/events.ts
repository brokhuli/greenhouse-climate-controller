import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../client";
import { toEventEntry, wireEventFeed } from "../schemas";
import { queryKeys, type EventScope } from "./keys";

const query = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
};

/** The activity feed, optionally scoped by greenhouse / kind / severity. Prepended by `event` frames. */
export function useEvents(scope: EventScope = {}) {
  return useQuery({
    queryKey: queryKeys.events(scope),
    queryFn: async () =>
      (
        await apiClient.get(
          `/events${query({ greenhouse_id: scope.greenhouseId, kind: scope.kind, severity: scope.severity })}`,
          wireEventFeed,
        )
      ).map(toEventEntry),
  });
}
