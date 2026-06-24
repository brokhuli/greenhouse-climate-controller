import { useParams } from "react-router-dom";
import { Card } from "../../components/Card";

/**
 * Placeholder for the per-greenhouse detail view (2a): live + historical charts, actuator panel,
 * setpoint edit, range picker. The data hooks (useGreenhouse, useTelemetry/useAnalytics) are ready.
 */
export default function GreenhouseDetail() {
  const { id } = useParams<{ id: string }>();
  return (
    <Card title={`Greenhouse ${id ?? ""}`}>
      <p className="text-fg-muted text-sm">
        Charts, actuator state, and the setpoint editor render here. Wires up{" "}
        <code className="font-mono">useGreenhouse()</code> and the telemetry hooks next.
      </p>
    </Card>
  );
}
