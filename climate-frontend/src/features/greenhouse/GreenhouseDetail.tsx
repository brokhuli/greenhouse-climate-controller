import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { SlidersHorizontal } from "lucide-react";
import type { ActuatorName, ActuatorState, Metric, Setpoints } from "../../api/schemas";
import { useFleet, useGreenhouse } from "../../api/queries/greenhouses";
import { useEvents } from "../../api/queries/events";
import { useAnalytics, useTelemetry } from "../../api/queries/telemetry";
import { liveSeriesKey, useLiveSeries } from "../../hooks/useLiveSeries";
import { useLiveActuators, type LiveActuators } from "../../hooks/useLiveActuators";
import { activeFaultCount, mergeReadings, rangeTierSelection } from "../../lib/derivations";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ui/ErrorState";
import { EventList } from "../../components/ui/EventList";
import { PanelHeader } from "../../components/ui/PanelHeader";
import { Pill } from "../../components/ui/Pill";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { type ReferenceLine } from "../../components/ui/TimeSeriesChart";
import {
  StackedTimeSeriesChart,
  type StackedBand,
} from "../../components/ui/StackedTimeSeriesChart";
import { ActuatorStatePanel, type ActuatorReading } from "./ActuatorStatePanel";
import { ZoneMoisturePanel, type ZoneMoistureRow } from "./ZoneMoisturePanel";
import { GreenhouseSummaryBar, type SummaryReadings } from "./GreenhouseSummaryBar";
import { analyticsReadings, telemetryReadings } from "./chartData";
import { usePersistentRange } from "../../hooks/usePersistentRange";
import { GreenhouseTimeScaleControl } from "./GreenhouseTimeScaleControl";
import { RangePicker } from "./RangePicker";
import { RetireGreenhouseAction } from "./RetireGreenhouseAction";
import { rangeMs } from "./range";

const SECTION_STYLE = { gap: "var(--layout-section-gap)" };
const CARD_GRID_STYLE = { gap: "var(--layout-card-gap)" };
const TOOLBAR_STYLE = { gap: "var(--layout-toolbar-gap)" };

const HOUSE_METRICS: { metric: Metric; label: string; color: string; unit: string }[] = [
  { metric: "temperature", label: "Temperature", color: "var(--chart-temperature)", unit: "°C" },
  { metric: "humidity", label: "Humidity", color: "var(--chart-humidity)", unit: "%RH" },
  { metric: "co2", label: "CO₂", color: "var(--chart-co2)", unit: "ppm" },
  { metric: "par", label: "PAR", color: "var(--chart-par)", unit: "µmol·m⁻²·s⁻¹" },
];

function houseReferences(metric: Metric, setpoints: Setpoints): ReferenceLine[] {
  switch (metric) {
    case "temperature":
      return [
        { label: "Day", value: setpoints.temperatureDayC },
        { label: "Night", value: setpoints.temperatureNightC },
      ];
    case "humidity":
      return [
        { label: "Low", value: setpoints.humidityLowPct },
        { label: "High", value: setpoints.humidityHighPct },
      ];
    case "co2":
      return [{ label: "Target", value: setpoints.co2TargetPpm }];
    default:
      return [];
  }
}

/** Latest commanded/observed per actuator: historical-latest from the range, overridden by live. */
function latestActuators(
  historical: ActuatorState[] | undefined,
  live: LiveActuators,
): ActuatorReading[] {
  const byActuator = new Map<ActuatorName, ActuatorReading>();
  if (historical) {
    const latest = new Map<ActuatorName, ActuatorState>();
    for (const sample of historical) {
      const prev = latest.get(sample.actuator);
      if (!prev || sample.ts > prev.ts) latest.set(sample.actuator, sample);
    }
    for (const [name, sample] of latest) {
      byActuator.set(name, {
        actuator: name,
        commanded: sample.commanded,
        observed: sample.observed,
      });
    }
  }
  for (const [name, sample] of live) {
    byActuator.set(name, {
      actuator: name,
      commanded: sample.commanded,
      observed: sample.observed,
    });
  }
  return [...byActuator.values()];
}

export default function GreenhouseDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // The chart range is a deep-linkable ?range= choice (default 1h). The last pick persists across
  // remounts via localStorage, so moving between greenhouses keeps the chosen range.
  const [rangeKey, setRange] = usePersistentRange("range", "detail:range");

  const windowMs = rangeMs(rangeKey);
  // The server resolves this window against the greenhouse's latest stored (simulated) timestamp,
  // so the seed lands on the same sim-time axis as the live edge (not the browser's wall clock).
  const historyWindow = useMemo(() => ({ window: rangeKey }), [rangeKey]);
  const tier = rangeTierSelection(windowMs);
  const isRaw = tier.tier === "raw";

  const greenhouse = useGreenhouse(id);
  const telemetry = useTelemetry(isRaw ? id : "", historyWindow);
  const analytics = useAnalytics(
    isRaw ? "" : id,
    historyWindow,
    tier.tier === "aggregate" ? tier.interval : "1h",
  );
  const events = useEvents({ greenhouseId: id });
  const live = useLiveSeries(id);
  const liveActuators = useLiveActuators(id);
  const fleet = useFleet();

  const detail = greenhouse.data;
  const actuatorReadings = useMemo(
    () => latestActuators(telemetry.data?.actuators, liveActuators),
    [telemetry.data, liveActuators],
  );

  if (greenhouse.isLoading) {
    return (
      <div className="flex flex-col" style={SECTION_STYLE}>
        <Skeleton height={48} />
        <Skeleton height={460} />
      </div>
    );
  }

  if (!detail) {
    return (
      <ErrorState
        title="Couldn't load this greenhouse"
        message={greenhouse.error?.message}
        onRetry={() => void greenhouse.refetch()}
      />
    );
  }

  const soilZones = detail.setpoints.zones;

  // The four house climate metrics, merged (history + live) into one set of stacked-chart bands.
  const climateBands: StackedBand[] = HOUSE_METRICS.map(({ metric, label, color, unit }) => {
    const historical = isRaw
      ? telemetryReadings(telemetry.data, metric, null)
      : analyticsReadings(analytics.data, metric, null);
    const liveReadings = isRaw ? (live.get(liveSeriesKey(metric, null)) ?? []) : [];
    const points = mergeReadings(historical, liveReadings, { windowMs });
    return {
      key: metric,
      label,
      color,
      unit,
      points,
      references: houseReferences(metric, detail.setpoints),
    };
  });

  // Summary tiles reuse the already-merged house bands; VPD isn't stacked, so merge it on its own.
  const latestBandPoint = (metric: Metric) =>
    climateBands.find((band) => band.key === metric)?.points.at(-1);
  const latestBand = (metric: Metric): number | undefined =>
    climateBands.find((band) => band.key === metric)?.points.at(-1)?.v;
  const vpdHistorical = isRaw
    ? telemetryReadings(telemetry.data, "vpd", null)
    : analyticsReadings(analytics.data, "vpd", null);
  const vpdLive = isRaw ? (live.get(liveSeriesKey("vpd", null)) ?? []) : [];
  const summaryReadings: SummaryReadings = {
    temperature: latestBand("temperature"),
    temperaturePoint: latestBandPoint("temperature"),
    humidity: latestBand("humidity"),
    co2: latestBand("co2"),
    vpd: mergeReadings(vpdHistorical, vpdLive, { windowMs }).at(-1)?.v,
  };
  // DLI lives on the fleet snapshot (it's a derived accumulator, not a detail-endpoint field).
  const dli = fleet.data?.find((summary) => summary.id === id)?.climate.dli ?? null;
  const faultCount = activeFaultCount(events.data ?? []);
  // Join each zone's mutable targets with its live status (keyed by zone_id) into the rows the
  // status table renders. Current moisture prefers the live edge over the snapshot, except a faulted
  // zone publishes nothing — show no value rather than a stale ring-buffer reading.
  const statusByZone = new Map(detail.zoneStatus.map((status) => [status.zoneId, status]));
  const zoneRows: ZoneMoistureRow[] = soilZones.map((zone) => {
    const status = statusByZone.get(zone.zoneId);
    const faulted = status?.faulted ?? false;
    const liveLatest = live.get(liveSeriesKey("soil_moisture", zone.zoneId))?.at(-1)?.value;
    const moistureVwc = faulted ? null : (liveLatest ?? status?.soilMoistureVwc ?? null);
    return {
      zoneId: zone.zoneId,
      moistureVwc,
      lowThreshold: zone.moistureLowThreshold,
      highThreshold: zone.moistureHighThreshold,
      lastWatered: status?.lastCycleTs ?? null,
      irrigating: status?.irrigating ?? false,
      faulted,
      schedule: zone.schedule,
    };
  });

  return (
    <div className="flex flex-col" style={SECTION_STYLE}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <StatusBadge status={detail.status} drift={detail.drift} />
          {detail.crop ? <Pill>{detail.crop}</Pill> : null}
        </div>
        <div className="flex flex-wrap items-center" style={TOOLBAR_STYLE}>
          {detail.timeScale != null ? (
            <>
              <span className="text-fg-muted text-sm">Speed</span>
              <GreenhouseTimeScaleControl greenhouseId={id} scale={detail.timeScale} />
            </>
          ) : null}
          <span className="text-fg-muted text-sm">Timescale</span>
          <RangePicker value={rangeKey} onChange={setRange} />
          <Button variant="primary" onClick={() => navigate(`/greenhouses/${id}/setpoints`)}>
            <SlidersHorizontal size={16} aria-hidden />
            Edit Setpoints
          </Button>
          <RetireGreenhouseAction greenhouseId={id} displayName={detail.displayName} />
        </div>
      </div>

      <GreenhouseSummaryBar
        status={detail.status}
        drift={detail.drift}
        setpoints={detail.setpoints}
        readings={summaryReadings}
        dli={dli}
        faultCount={faultCount}
      />

      <div
        className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]"
        style={CARD_GRID_STYLE}
      >
        <div className="flex flex-col" style={CARD_GRID_STYLE}>
          <Card>
            <PanelHeader title="Climate overview" sectionLabel titleSize="large" />
            <StackedTimeSeriesChart bands={climateBands} />
          </Card>
          <Card>
            <PanelHeader title="Soil moisture" sectionLabel titleSize="large" />
            <ZoneMoisturePanel rows={zoneRows} />
          </Card>
        </div>
        <div className="flex flex-col" style={CARD_GRID_STYLE}>
          <Card>
            <PanelHeader title="Actuator states" sectionLabel titleSize="large" />
            <ActuatorStatePanel actuators={actuatorReadings} />
          </Card>
          <Card>
            <PanelHeader title="Recent Activity" sectionLabel titleSize="large" />
            {events.isLoading ? (
              <Skeleton height={120} />
            ) : (
              <EventList events={events.data ?? []} showGreenhouse={false} />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
