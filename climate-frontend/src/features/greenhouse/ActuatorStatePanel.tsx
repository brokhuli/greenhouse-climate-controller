import type { ActuatorName } from "../../api/schemas";

/**
 * Commanded vs observed actuator positions (components §3). Presentational: the detail view merges
 * the historical-latest sample with the live stream and hands the current positions here.
 */
export type ActuatorReading = {
  actuator: ActuatorName;
  commanded: number;
  observed: number | null;
};

const LABELS: Record<ActuatorName, string> = {
  heater: "Heater",
  fans: "Fans",
  roof_vents: "Roof vents",
  misters: "Misters",
  co2_injector: "CO₂ injector",
  grow_lights: "Grow lights",
  shade_screen: "Shade screen",
  irrigation_valve: "Irrigation valve",
};

const clamp = (value: number): number => Math.max(0, Math.min(100, value));

export function ActuatorStatePanel({ actuators }: { actuators: ActuatorReading[] }) {
  if (actuators.length === 0) {
    return <p className="text-fg-subtle text-sm">No actuator data in range.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {actuators.map((entry) => (
        <div key={entry.actuator} className="flex items-center gap-3">
          <span className="text-fg-default w-28 shrink-0 text-sm">{LABELS[entry.actuator]}</span>
          <div className="bg-surface-3 h-2 flex-1 overflow-hidden rounded-full">
            <div
              className="h-full rounded-full"
              style={{
                width: `${clamp(entry.commanded)}%`,
                backgroundColor: "var(--color-accent)",
              }}
            />
          </div>
          <span className="text-fg-muted w-28 shrink-0 text-right font-mono text-xs tabular-nums">
            cmd {Math.round(entry.commanded)}% · obs{" "}
            {entry.observed == null ? "—" : `${Math.round(entry.observed)}%`}
          </span>
        </div>
      ))}
    </div>
  );
}
