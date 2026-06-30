import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useEvents } from "../../api/queries/events";
import { useFleet } from "../../api/queries/greenhouses";
import type { EventKind, EventSeverity } from "../../api/schemas";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorState } from "../../components/ui/ErrorState";
import { EventList } from "../../components/ui/EventList";
import { Skeleton } from "../../components/ui/Skeleton";
import { formatGreenhouseLabel } from "../../lib/derivations";

/**
 * Site-wide activity feed (components §2): faults, interlocks, setpoint edits, profile applies,
 * drift — severity-grouped, filterable by kind/severity, and prepended live by `event` frames
 * (the StreamProvider patches the matching `["events", scope]` cache entry). Critical events also
 * raise a toast at the source.
 */
const KIND_OPTIONS: EventKind[] = [
  "fault",
  "interlock",
  "profile_applied",
  "setpoint_edit",
  "drift",
];
const SEVERITY_OPTIONS: EventSeverity[] = ["info", "warning", "critical"];

const selectClass = "border-border bg-surface-2 text-fg-default rounded-md border px-2 text-sm";

export default function ActivityFeed() {
  const [kind, setKind] = useState<EventKind | "">("");
  const [severity, setSeverity] = useState<EventSeverity | "">("");
  const [searchParams, setSearchParams] = useSearchParams();
  const fleet = useFleet();
  const greenhouseId = searchParams.get("greenhouse_id") ?? "";

  const setGreenhouseId = (nextGreenhouseId: string) => {
    const next = new URLSearchParams(searchParams);
    if (nextGreenhouseId) {
      next.set("greenhouse_id", nextGreenhouseId);
    } else {
      next.delete("greenhouse_id");
    }
    setSearchParams(next, { replace: true });
  };

  const events = useEvents({
    greenhouseId: greenhouseId || undefined,
    kind: kind || undefined,
    severity: severity || undefined,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-fg-default text-lg font-semibold">Activity</h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={greenhouseId}
            onChange={(event) => setGreenhouseId(event.target.value)}
            aria-label="Filter by greenhouse"
            className={selectClass}
            style={{ height: "var(--size-control-sm)" }}
          >
            <option value="">All greenhouses</option>
            {(fleet.data ?? []).map((greenhouse) => (
              <option key={greenhouse.id} value={greenhouse.id}>
                {formatGreenhouseLabel(greenhouse.displayName)}
              </option>
            ))}
          </select>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as EventKind | "")}
            aria-label="Filter by kind"
            className={selectClass}
            style={{ height: "var(--size-control-sm)" }}
          >
            <option value="">All kinds</option>
            {KIND_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <select
            value={severity}
            onChange={(event) => setSeverity(event.target.value as EventSeverity | "")}
            aria-label="Filter by severity"
            className={selectClass}
            style={{ height: "var(--size-control-sm)" }}
          >
            <option value="">All severities</option>
            {SEVERITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>

      {events.isLoading ? (
        <Card>
          <Skeleton height={200} />
        </Card>
      ) : events.isError ? (
        <ErrorState
          title="Couldn't load activity"
          message={events.error?.message}
          onRetry={() => void events.refetch()}
        />
      ) : (events.data ?? []).length === 0 ? (
        <EmptyState title="No activity" message="No events match the current filters." />
      ) : (
        <Card>
          <EventList events={events.data ?? []} groupBySeverity />
        </Card>
      )}
    </div>
  );
}
