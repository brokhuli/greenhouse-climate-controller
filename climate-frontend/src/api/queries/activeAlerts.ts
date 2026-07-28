import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../client";
import { toActiveAlert, wireActiveAlertFeed } from "../schemas";
import { queryKeys, type EventScope } from "./keys";

const query = (scope: EventScope): string => {
  const params = new URLSearchParams();
  if (scope.greenhouseId) params.set("greenhouse_id", scope.greenhouseId);
  if (scope.kind) params.set("kind", scope.kind);
  if (scope.severity) params.set("severity", scope.severity);
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
};

/** Current controller-reported alerts, scoped like the activity feed. */
export function useActiveAlerts(scope: EventScope = {}) {
  return useQuery({
    queryKey: queryKeys.activeAlerts(scope),
    queryFn: async () =>
      (await apiClient.get(`/active-alerts${query(scope)}`, wireActiveAlertFeed)).map(
        toActiveAlert,
      ),
  });
}
