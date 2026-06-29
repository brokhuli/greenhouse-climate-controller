import type { EventEntry, EventSeverity } from "../../api/schemas";

/**
 * Chronological event rows — faults, interlocks, setpoint edits, profile applies, drift
 * (components §2/§3). Presentational: the feature supplies already-fetched/-filtered events. Used
 * by both the greenhouse detail panel (flat) and the activity feed (severity-grouped). Severity is
 * carried by a text label, not color alone.
 */
const SEVERITY_COLOR: Record<EventSeverity, string> = {
  info: "var(--color-info)",
  warning: "var(--color-warning)",
  critical: "var(--color-fault)",
};

const SEVERITY_ORDER: EventSeverity[] = ["critical", "warning", "info"];

const formatEventDate = (date: Date): string =>
  date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

const formatEventTime = (date: Date): string =>
  date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function EventRow({ event, showGreenhouse }: { event: EventEntry; showGreenhouse: boolean }) {
  return (
    <li className="border-divider flex items-start gap-3 border-b py-2 last:border-b-0">
      <span className="text-fg-subtle mt-0.5 flex w-20 shrink-0 flex-col font-mono text-xs tabular-nums">
        <span>{formatEventDate(event.ts)}</span>
        <span className="whitespace-nowrap">{formatEventTime(event.ts)}</span>
      </span>
      <span
        className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: SEVERITY_COLOR[event.severity] }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-fg-default text-sm">{event.message}</p>
        <p className="text-fg-subtle text-xs">
          {event.kind.replace(/_/g, " ")}
          {event.source ? ` · ${event.source}` : ""}
          {showGreenhouse ? ` · ${event.greenhouseId}` : ""}
        </p>
      </div>
      <span
        className="shrink-0 text-xs font-medium"
        style={{ color: SEVERITY_COLOR[event.severity] }}
      >
        {event.severity}
      </span>
    </li>
  );
}

export function EventList({
  events,
  groupBySeverity = false,
  showGreenhouse = true,
}: {
  events: EventEntry[];
  groupBySeverity?: boolean;
  showGreenhouse?: boolean;
}) {
  if (events.length === 0) {
    return <p className="text-fg-subtle py-4 text-sm">No events.</p>;
  }

  if (!groupBySeverity) {
    return (
      <ul>
        {events.map((event, index) => (
          <EventRow
            key={`${event.greenhouseId}-${event.ts.getTime()}-${index}`}
            event={event}
            showGreenhouse={showGreenhouse}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {SEVERITY_ORDER.map((severity) => {
        const group = events.filter((event) => event.severity === severity);
        if (group.length === 0) return null;
        return (
          <div key={severity}>
            <p className="section-label mb-1" style={{ color: SEVERITY_COLOR[severity] }}>
              {severity} ({group.length})
            </p>
            <ul>
              {group.map((event, index) => (
                <EventRow
                  key={`${event.greenhouseId}-${event.ts.getTime()}-${index}`}
                  event={event}
                  showGreenhouse={showGreenhouse}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
