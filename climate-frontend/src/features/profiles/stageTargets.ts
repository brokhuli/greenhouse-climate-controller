import {
  Carrot,
  Cherry,
  Cloud,
  Droplets,
  Grape,
  LeafyGreen,
  Sprout,
  Sun,
  ThermometerSnowflake,
  ThermometerSun,
  Wheat,
  Wind,
  type LucideIcon,
} from "lucide-react";
import type { ScalarSetpointKey, Setpoints, StageBounds } from "../../api/schemas";

/**
 * View helpers for the crop-profile detail panes (profiles §master–detail). Kept pure and out of JSX
 * so the label/unit/icon mapping and the summary formatting are unit-tested in isolation, mirroring
 * the optimizer's DIFF_FIELDS table (features/optimizer/derivations.ts).
 */

/** At most two decimals, trailing zeros stripped (900 → "900", 22.5 → "22.5", 1.05 → "1.05"). */
export const fmt = (n: number): string => String(Math.round(n * 100) / 100);

/** The presentation metadata for one scalar climate target: its label, unit, icon, and metric color. */
export type ClimateMetric = {
  key: ScalarSetpointKey;
  label: string;
  unit: string;
  Icon: LucideIcon;
  /** A theme-agnostic chart token so a metric keeps its identity (tokens.css §Chart). */
  colorVar: string;
};

/**
 * Every scalar climate target a stage carries, in a logical read order. The icon + color let the
 * detail pane render each metric with its own identity; the color is a chart token, never a status one.
 */
export const CLIMATE_METRICS: ClimateMetric[] = [
  {
    key: "temperatureDayC",
    label: "Temp — day",
    unit: "°C",
    Icon: ThermometerSun,
    colorVar: "--chart-temperature",
  },
  {
    key: "temperatureNightC",
    label: "Temp — night",
    unit: "°C",
    Icon: ThermometerSnowflake,
    colorVar: "--chart-temperature",
  },
  {
    key: "humidityLowPct",
    label: "Humidity min",
    unit: "% RH",
    Icon: Droplets,
    colorVar: "--chart-humidity",
  },
  {
    key: "humidityHighPct",
    label: "Humidity max",
    unit: "% RH",
    Icon: Droplets,
    colorVar: "--chart-humidity",
  },
  {
    key: "humidityDeadbandPct",
    label: "Humidity deadband",
    unit: "% RH",
    Icon: Droplets,
    colorVar: "--chart-humidity",
  },
  { key: "vpdTargetKpa", label: "VPD target", unit: "kPa", Icon: Wind, colorVar: "--chart-vpd" },
  {
    key: "co2TargetPpm",
    label: "CO₂ target",
    unit: "ppm",
    Icon: Cloud,
    colorVar: "--chart-co2",
  },
  {
    key: "co2VentInterlockThresholdPct",
    label: "CO₂ vent interlock",
    unit: "%",
    Icon: Cloud,
    colorVar: "--chart-co2",
  },
  {
    key: "dliTargetMol",
    label: "DLI target",
    unit: "mol/m²/d",
    Icon: Sun,
    colorVar: "--chart-par",
  },
];

/** One rendered climate-target row: the formatted value and, when the stage carries an envelope, its
 * crop-safe range as a subtle secondary line. */
export type ClimateTargetRow = {
  key: ScalarSetpointKey;
  label: string;
  value: string;
  unit: string;
  Icon: LucideIcon;
  colorVar: string;
  /** The crop-safe `[min, max]` the optimizer may refine within, or null when the stage has no envelope. */
  range: string | null;
};

/** The right-pane climate rows for one stage: every scalar target with its value and crop-safe range. */
export function climateTargetRows(targets: Setpoints, bounds?: StageBounds): ClimateTargetRow[] {
  return CLIMATE_METRICS.map((metric) => {
    const bound = bounds?.[metric.key];
    return {
      key: metric.key,
      label: metric.label,
      value: fmt(targets[metric.key]),
      unit: metric.unit,
      Icon: metric.Icon,
      colorVar: metric.colorVar,
      range: bound ? `${fmt(bound.min)}–${fmt(bound.max)}` : null,
    };
  });
}

/** One compact key/value chip in a stage's middle-pane summary. */
export type SummaryChip = { label: string; value: string };

/** The condensed at-a-glance summary shown per stage in the profile's stage list. */
export function stageSummary(targets: Setpoints): SummaryChip[] {
  return [
    {
      label: "Day/Night",
      value: `${fmt(targets.temperatureDayC)}/${fmt(targets.temperatureNightC)} °C`,
    },
    { label: "RH", value: `${fmt(targets.humidityLowPct)}–${fmt(targets.humidityHighPct)} %` },
    { label: "VPD", value: `${fmt(targets.vpdTargetKpa)} kPa` },
    { label: "CO₂", value: `${fmt(targets.co2TargetPpm)} ppm` },
    { label: "DLI", value: `${fmt(targets.dliTargetMol)} mol` },
  ];
}

/** The daylight window as a single `HH:MM – HH:MM` label. */
export function dayWindow(targets: Setpoints): string {
  return `${targets.dayStart} – ${targets.dayEnd}`;
}

// A crop name maps to the closest lucide botanical icon; unmatched crops fall back to a generic sprout
// (lucide has no tomato/pepper/cucumber icon). Ordered most-specific first.
const CROP_ICONS: { match: RegExp; Icon: LucideIcon }[] = [
  { match: /lettuce|greens?|spinach|kale|basil|herb|chard|arugula|leaf/, Icon: LeafyGreen },
  { match: /carrot|radish|beet|turnip|root/, Icon: Carrot },
  { match: /grape|vine/, Icon: Grape },
  { match: /wheat|grain|barley|rice|corn|maize|oat/, Icon: Wheat },
  { match: /strawberr|cherry|berry/, Icon: Cherry },
];

/** The botanical icon for a crop, falling back to a generic sprout for anything unmatched. */
export function cropIcon(crop: string): LucideIcon {
  const key = crop.toLowerCase();
  for (const { match, Icon } of CROP_ICONS) {
    if (match.test(key)) return Icon;
  }
  return Sprout;
}
