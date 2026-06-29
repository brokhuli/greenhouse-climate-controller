import type { ReactNode } from "react";
import {
  Cloud,
  Droplet,
  Leaf,
  Sun,
  Target,
  Thermometer,
  TriangleAlert,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import type { Connectivity, Setpoints } from "../../api/schemas";
import { SummaryStat } from "../../components/ui/SummaryStat";

const GRID_STYLE = { gap: "var(--layout-card-gap)" };
const SUMMARY_STAT_PROPS = { density: "compact" as const };

/** Latest house climate readings, sourced from the same merged telemetry the charts plot. */
export type SummaryReadings = {
  temperature?: number;
  humidity?: number;
  co2?: number;
  vpd?: number;
};

const STATUS_META: Record<
  Connectivity,
  { label: string; color: string; Icon: LucideIcon; dot: boolean }
> = {
  online: { label: "Online", color: "var(--color-status-online)", Icon: Wifi, dot: false },
  degraded: {
    label: "Degraded",
    color: "var(--color-status-degraded)",
    Icon: TriangleAlert,
    dot: true,
  },
  offline: { label: "Offline", color: "var(--color-status-offline)", Icon: WifiOff, dot: false },
};

/** A whole-number-or-one-decimal setpoint readout (no trailing ".0" on round targets). */
const fmt = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));

/** Big reading with a smaller, muted unit suffix; an em dash when the reading is unavailable. */
function metricValue(
  value: number | null | undefined,
  format: (v: number) => string,
  unit: string,
): ReactNode {
  if (value == null) return "—";
  return (
    <>
      {format(value)}
      <span className="text-fg-muted ml-1 text-sm font-normal">{unit}</span>
    </>
  );
}

/**
 * Greenhouse-level summary tiles shown above the detail charts: the live house climate beside its
 * setpoint/target, plus health rollups (connectivity + drift). Mirrors the fleet summary bar's tile
 * style — current readings come from the same merged telemetry the charts plot, DLI from the fleet
 * snapshot, and the fault count from the activity feed.
 */
export function GreenhouseSummaryBar({
  status,
  drift,
  setpoints,
  readings,
  dli,
  faultCount,
}: {
  status: Connectivity;
  drift: boolean;
  setpoints: Setpoints;
  readings: SummaryReadings;
  dli: number | null | undefined;
  faultCount: number;
}) {
  const statusMeta = STATUS_META[status];
  return (
    <div
      className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7"
      style={GRID_STYLE}
    >
      <SummaryStat
        {...SUMMARY_STAT_PROPS}
        label="Temperature"
        value={metricValue(readings.temperature, (v) => v.toFixed(1), "°C")}
        caption={`Setpoint ${fmt(setpoints.temperatureDayC)}`}
        Icon={Thermometer}
        color="var(--chart-temperature)"
      />
      <SummaryStat
        {...SUMMARY_STAT_PROPS}
        label="Humidity"
        value={metricValue(readings.humidity, (v) => String(Math.round(v)), "%")}
        caption={`Setpoint ${fmt(setpoints.humidityLowPct)} – ${fmt(setpoints.humidityHighPct)}`}
        Icon={Droplet}
        color="var(--chart-humidity)"
      />
      <SummaryStat
        {...SUMMARY_STAT_PROPS}
        label="VPD"
        value={metricValue(readings.vpd, (v) => v.toFixed(2), "kPa")}
        caption={`Target ${fmt(setpoints.vpdTargetKpa)}`}
        Icon={Leaf}
        color="var(--chart-vpd)"
      />
      <SummaryStat
        {...SUMMARY_STAT_PROPS}
        label="CO₂"
        value={metricValue(readings.co2, (v) => String(Math.round(v)), "ppm")}
        caption={`Target ${fmt(setpoints.co2TargetPpm)}`}
        Icon={Cloud}
        color="var(--chart-co2)"
      />
      <SummaryStat
        {...SUMMARY_STAT_PROPS}
        label="DLI"
        value={metricValue(dli, (v) => v.toFixed(1), "mol/m²/d")}
        caption={`Target ${fmt(setpoints.dliTargetMol)}`}
        Icon={Sun}
        color="var(--chart-par)"
      />
      <SummaryStat
        {...SUMMARY_STAT_PROPS}
        label="Status"
        value={statusMeta.label}
        caption={`${faultCount} active fault${faultCount === 1 ? "" : "s"}`}
        Icon={statusMeta.Icon}
        color={statusMeta.color}
        dot={statusMeta.dot}
      />
      <SummaryStat
        {...SUMMARY_STAT_PROPS}
        label="Drift"
        value={drift ? "Yes" : "No"}
        caption={drift ? "Setpoints mismatched" : "In sync"}
        Icon={Target}
        color={drift ? "var(--color-status-drift)" : "var(--color-fg-subtle)"}
        dot={drift}
      />
    </div>
  );
}
