import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { ActuatorName, ActuatorState, Metric, Setpoints } from "../../api/schemas";
import { useGreenhouse } from "../../api/queries/greenhouses";
import { useEvents } from "../../api/queries/events";
import { useAnalytics, useTelemetry } from "../../api/queries/telemetry";
import { liveSeriesKey, useLiveSeries } from "../../hooks/useLiveSeries";
import { useLiveActuators, type LiveActuators } from "../../hooks/useLiveActuators";
import { mergeReadings, rangeTierSelection } from "../../lib/derivations";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ui/ErrorState";
import { EventList } from "../../components/ui/EventList";
import { PanelHeader } from "../../components/ui/PanelHeader";
import { Pill } from "../../components/ui/Pill";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { TimeSeriesChart, type ReferenceLine } from "../../components/ui/TimeSeriesChart";
import { ActuatorStatePanel, type ActuatorReading } from "./ActuatorStatePanel";
import { analyticsReadings, telemetryReadings } from "./chartData";
import { GreenhouseTimeScaleControl } from "./GreenhouseTimeScaleControl";
import { RangePicker } from "./RangePicker";
import { RetireGreenhouseAction } from "./RetireGreenhouseAction";
import { SetpointEditForm } from "./SetpointEditForm";
import { isRangeKey, rangeMs, type RangeKey } from "./range";

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

const format = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

export default function GreenhouseDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const rangeParam = searchParams.get("range");
  const rangeKey: RangeKey = isRangeKey(rangeParam) ? rangeParam : "1h";

  const setRange = (key: RangeKey) => {
    const next = new URLSearchParams(searchParams);
    next.set("range", key);
    setSearchParams(next, { replace: true });
  };

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

  const detail = greenhouse.data;
  const actuatorReadings = useMemo(
    () => latestActuators(telemetry.data?.actuators, liveActuators),
    [telemetry.data, liveActuators],
  );

  if (greenhouse.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton height={48} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} height={220} />
          ))}
        </div>
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

  const offline = detail.status === "offline";
  const soilZones = detail.setpoints.zones;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-fg-default text-lg font-semibold">{detail.displayName}</h2>
          <StatusBadge status={detail.status} drift={detail.drift} />
          {detail.crop ? <Pill>{detail.crop}</Pill> : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {detail.timeScale != null ? (
            <>
              <span className="text-fg-muted text-sm">Speed</span>
              <GreenhouseTimeScaleControl greenhouseId={id} scale={detail.timeScale} />
            </>
          ) : null}
          <span className="text-fg-muted text-sm">Timescale</span>
          <RangePicker value={rangeKey} onChange={setRange} />
          <RetireGreenhouseAction greenhouseId={id} displayName={detail.displayName} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {HOUSE_METRICS.map(({ metric, label, color, unit }) => {
          const historical = isRaw
            ? telemetryReadings(telemetry.data, metric, null)
            : analyticsReadings(analytics.data, metric, null);
          const liveReadings = isRaw ? (live.get(liveSeriesKey(metric, null)) ?? []) : [];
          const points = mergeReadings(historical, liveReadings, { windowMs });
          const latest = points.at(-1)?.v;
          return (
            <Card key={metric}>
              <PanelHeader
                title={label}
                value={latest !== undefined ? `${format(latest)} ${unit}` : "—"}
              />
              <TimeSeriesChart
                series={{ label, color, points }}
                references={houseReferences(metric, detail.setpoints)}
                unit={unit}
              />
            </Card>
          );
        })}

        {soilZones.map((zone) => {
          const historical = isRaw
            ? telemetryReadings(telemetry.data, "soil_moisture", zone.zoneId)
            : analyticsReadings(analytics.data, "soil_moisture", zone.zoneId);
          const liveReadings = isRaw
            ? (live.get(liveSeriesKey("soil_moisture", zone.zoneId)) ?? [])
            : [];
          const points = mergeReadings(historical, liveReadings, { windowMs });
          const latest = points.at(-1)?.v;
          return (
            <Card key={`soil-${zone.zoneId}`}>
              <PanelHeader
                title={`Soil moisture · ${zone.zoneId}`}
                value={latest !== undefined ? `${format(latest)} VWC` : "—"}
              />
              <TimeSeriesChart
                series={{
                  label: `Soil moisture (${zone.zoneId})`,
                  color: "var(--chart-soil-moisture)",
                  points,
                }}
                references={[
                  { label: "Low", value: zone.moistureLowThreshold },
                  { label: "High", value: zone.moistureHighThreshold },
                ]}
                unit="VWC"
              />
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <PanelHeader title="Actuators" />
          <ActuatorStatePanel actuators={actuatorReadings} />
        </Card>
        <Card>
          <PanelHeader title="Recent activity" />
          {events.isLoading ? (
            <Skeleton height={120} />
          ) : (
            <EventList events={events.data ?? []} showGreenhouse={false} />
          )}
        </Card>
      </div>

      <SetpointEditForm greenhouseId={id} setpoints={detail.setpoints} offline={offline} />
    </div>
  );
}
