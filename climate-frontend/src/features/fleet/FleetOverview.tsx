import { Card } from "../../components/Card";

/**
 * Placeholder for the fleet landing view (2a). The fleet grid + site rollup land in the next
 * slice; the contract-bound data layer it will consume (useFleet, status/drift WS patches) is ready.
 */
export default function FleetOverview() {
  return (
    <Card title="Fleet overview">
      <p className="text-fg-muted text-sm">
        The fleet grid and site rollup render here. The data layer is in place — this view will wire
        up <code className="font-mono">useFleet()</code> and the live status stream next.
      </p>
    </Card>
  );
}
