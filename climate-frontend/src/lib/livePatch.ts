import type { QueryClient } from "@tanstack/react-query";
import { queryKeys, type EventScope } from "../api/queries/keys";
import type {
  DriftFrame,
  EventEntry,
  EventFrame,
  GreenhouseDetail,
  GreenhouseSummary,
  StatusFrame,
  TelemetryFrame,
} from "../api/schemas";

/**
 * Apply live WebSocket frames to the React Query cache in place (architecture §4 "WS patches over
 * refetch"). The per-frame transforms are pure and return the *same* reference when nothing changes
 * so memoized cards/charts don't re-render needlessly (components §5). The `apply*` functions wrap
 * those transforms with the cache writes the StreamProvider performs.
 */

// ---------------------------------------------------------------------------
// Pure transforms (unit-tested in isolation)
// ---------------------------------------------------------------------------

/** A `status` frame is the authoritative source for connectivity + simulation time-scale. */
export function applyStatusToSummary(
  summary: GreenhouseSummary,
  frame: StatusFrame,
): GreenhouseSummary {
  const timeScale = frame.time_scale ?? summary.timeScale;
  if (summary.status === frame.status && summary.timeScale === timeScale) return summary;
  return { ...summary, status: frame.status, timeScale };
}

/** A house-level `temperature` reading keeps the fleet card's metric tile live. */
export function applyTelemetryToSummary(
  summary: GreenhouseSummary,
  frame: TelemetryFrame,
): GreenhouseSummary {
  if (frame.zone_id !== null) return summary; // zone readings don't drive the house tile
  const temperature = frame.readings.find((reading) => reading.metric === "temperature");
  if (!temperature || summary.climate.temperature === temperature.value) return summary;
  return { ...summary, climate: { ...summary.climate, temperature: temperature.value } };
}

export function eventFrameToEntry(frame: EventFrame): EventEntry {
  return {
    greenhouseId: frame.greenhouse_id,
    ts: new Date(frame.ts),
    kind: frame.kind,
    severity: frame.severity,
    message: frame.message,
    source: frame.source,
  };
}

/** Whether a live event belongs in an activity query opened with the given filter scope. */
export function eventMatchesScope(entry: EventEntry, scope: EventScope): boolean {
  if (scope.greenhouseId && entry.greenhouseId !== scope.greenhouseId) return false;
  if (scope.kind && entry.kind !== scope.kind) return false;
  if (scope.severity && entry.severity !== scope.severity) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Cache writes (apply a transform to the live query entries)
// ---------------------------------------------------------------------------

function patchFleetSummary(
  queryClient: QueryClient,
  greenhouseId: string,
  patch: (summary: GreenhouseSummary) => GreenhouseSummary,
): void {
  queryClient.setQueryData<GreenhouseSummary[]>(queryKeys.fleet(), (fleet) => {
    if (!fleet) return fleet;
    let changed = false;
    const next = fleet.map((summary) => {
      if (summary.id !== greenhouseId) return summary;
      const updated = patch(summary);
      if (updated !== summary) changed = true;
      return updated;
    });
    return changed ? next : fleet;
  });
}

function patchGreenhouseDetail(
  queryClient: QueryClient,
  greenhouseId: string,
  patch: (detail: GreenhouseDetail) => GreenhouseDetail,
): void {
  queryClient.setQueryData<GreenhouseDetail>(queryKeys.greenhouse(greenhouseId), (detail) =>
    detail ? patch(detail) : detail,
  );
}

export function applyStatusFrame(queryClient: QueryClient, frame: StatusFrame): void {
  patchFleetSummary(queryClient, frame.greenhouse_id, (summary) =>
    applyStatusToSummary(summary, frame),
  );
  patchGreenhouseDetail(queryClient, frame.greenhouse_id, (detail) => {
    const timeScale = frame.time_scale ?? detail.timeScale;
    if (detail.status === frame.status && detail.timeScale === timeScale) return detail;
    return { ...detail, status: frame.status, timeScale };
  });
}

export function applyDriftFrame(queryClient: QueryClient, frame: DriftFrame): void {
  patchFleetSummary(queryClient, frame.greenhouse_id, (summary) =>
    summary.drift === frame.drift ? summary : { ...summary, drift: frame.drift },
  );
  patchGreenhouseDetail(queryClient, frame.greenhouse_id, (detail) =>
    detail.drift === frame.drift ? detail : { ...detail, drift: frame.drift },
  );
}

export function applyTelemetryFrame(queryClient: QueryClient, frame: TelemetryFrame): void {
  patchFleetSummary(queryClient, frame.greenhouse_id, (summary) =>
    applyTelemetryToSummary(summary, frame),
  );
}

/** Prepend a live event to every open activity query whose filter scope it matches. */
export function applyEventFrame(queryClient: QueryClient, frame: EventFrame): void {
  const entry = eventFrameToEntry(frame);
  const queries = queryClient.getQueryCache().findAll({ queryKey: ["events"] });
  for (const query of queries) {
    const scope = (query.queryKey[1] as EventScope | undefined) ?? {};
    if (!eventMatchesScope(entry, scope)) continue;
    queryClient.setQueryData<EventEntry[]>(query.queryKey, (list) =>
      list ? [entry, ...list] : list,
    );
  }
}
