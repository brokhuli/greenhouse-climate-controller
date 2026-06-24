import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../client";
import {
  toAnalyticsResponse,
  toTelemetryRange,
  wireAnalyticsResponse,
  wireTelemetryRange,
  type AnalyticsInterval,
  type Metric,
} from "../schemas";
import { queryKeys, type RangeParams } from "./keys";

const query = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
};

/** Raw historical telemetry over [from, to] — the chart's historical portion for short ranges. */
export function useTelemetry(id: string, range: RangeParams) {
  return useQuery({
    queryKey: queryKeys.telemetry(id, range),
    queryFn: async () =>
      toTelemetryRange(
        await apiClient.get(
          `/greenhouses/${id}/telemetry${query({ from: range.from, to: range.to })}`,
          wireTelemetryRange,
        ),
      ),
    enabled: id.length > 0,
  });
}

/** Time-bucketed aggregates over [from, to] — the chart's historical portion for long ranges. */
export function useAnalytics(
  id: string,
  range: RangeParams,
  interval: AnalyticsInterval,
  metric?: Metric,
) {
  return useQuery({
    queryKey: queryKeys.analytics(id, range, interval),
    queryFn: async () =>
      toAnalyticsResponse(
        await apiClient.get(
          `/greenhouses/${id}/analytics${query({ from: range.from, to: range.to, interval, metric })}`,
          wireAnalyticsResponse,
        ),
      ),
    enabled: id.length > 0,
  });
}
