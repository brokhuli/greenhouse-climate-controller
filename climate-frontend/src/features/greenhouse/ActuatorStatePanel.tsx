import {
  Blinds,
  Cloud,
  Droplet,
  Droplets,
  Fan,
  Flame,
  Lightbulb,
  Wind,
  type LucideIcon,
} from "lucide-react";
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

// CO₂ reuses the Cloud glyph the climate summary already uses for the metric, so the two views read
// consistently; the rest map an actuator to its closest physical-action icon.
const ICONS: Record<ActuatorName, LucideIcon> = {
  heater: Flame,
  fans: Fan,
  roof_vents: Wind,
  misters: Droplets,
  co2_injector: Cloud,
  grow_lights: Lightbulb,
  shade_screen: Blinds,
  irrigation_valve: Droplet,
};

const clamp = (value: number): number => Math.max(0, Math.min(100, value));

/** Filled On/Off chip: tinted green when running, neutral when idle. Text carries the state so it
 *  is never color-only (constraints §a11y). */
function StatePill({ on }: { on: boolean }) {
  return on ? (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{
        backgroundColor: "color-mix(in srgb, var(--color-status-online) 18%, transparent)",
        color: "var(--color-status-online)",
      }}
    >
      On
    </span>
  ) : (
    <span className="bg-surface-3 text-fg-subtle shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">
      Off
    </span>
  );
}

export function ActuatorStatePanel({ actuators }: { actuators: ActuatorReading[] }) {
  if (actuators.length === 0) {
    return <p className="text-fg-subtle text-sm">No actuator data in range.</p>;
  }
  return (
    <div className="flex flex-col">
      {actuators.map((entry) => {
        const Icon = ICONS[entry.actuator];
        const commanded = clamp(entry.commanded);
        return (
          <div
            key={entry.actuator}
            className="border-divider flex items-center gap-3 border-b py-2 last:border-b-0"
          >
            <Icon size={16} className="text-fg-muted shrink-0" aria-hidden />
            <span className="text-fg-default min-w-0 flex-1 truncate text-sm">
              {LABELS[entry.actuator]}
            </span>
            <span className="text-fg-muted shrink-0 font-mono text-sm tabular-nums">
              {Math.round(commanded)} %
            </span>
            <StatePill on={commanded > 0} />
          </div>
        );
      })}
    </div>
  );
}
