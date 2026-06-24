import { Card } from "../../components/Card";

/**
 * Placeholder for the activity / health feed (2a). The severity-grouped event list lands next,
 * consuming useEvents() and prepended by live `event` frames.
 */
export default function ActivityFeed() {
  return (
    <Card title="Activity">
      <p className="text-fg-muted text-sm">
        Faults, interlocks, and setpoint edits stream into this feed. Wires up{" "}
        <code className="font-mono">useEvents()</code> next.
      </p>
    </Card>
  );
}
