package api

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
)

// planningContextSchemaVersion is the response schema major the optimizer's
// identity-consistency check reads. It tracks info.version's major in
// contracts/platform-optimizer-planning-rest/openapi.json — bump both together.
const planningContextSchemaVersion = 1

// planningWindowToDuration maps the planning-context window enum to a trailing duration. It
// is deliberately separate from the dashboard's windowToDuration: this contract offers the
// optimizer's longer history spans (its 12 h horizon, 24 h at day boundaries), not the
// dashboard's chart ranges.
var planningWindowToDuration = map[string]time.Duration{
	"6h":  6 * time.Hour,
	"12h": 12 * time.Hour,
	"24h": 24 * time.Hour,
	"48h": 48 * time.Hour,
}

// planningIntervalToSQL maps the summary bucket-width enum to a PostgreSQL interval. Narrower
// than the dashboard's analytics enum — the LLM context strategy consumes hourly summaries.
var planningIntervalToSQL = map[string]string{
	"1h": "1 hour",
	"6h": "6 hours",
	"1d": "1 day",
}

// defaultActuatorHealth is what an actuator reports when no live snapshot has been observed
// for it yet. "ok" matches the controller's own default: health is a readback *fault*
// signal, and its absence is the healthy case, not an unknown one.
const defaultActuatorHealth = "ok"

// getPlanningContext serves the Phase 3 optimizer's single bounded read per planning cycle
// (contracts/platform-optimizer-planning-rest, RFC-008 revised): current setpoints and their
// crop-safe envelope, bucketed telemetry summaries, latest actuator states, and the
// data-quality signals its input gate runs. The read carries no authority and no safety
// concern, so it is unauthenticated on the trusted Docker network (RFC-011 scopes service
// auth to the write boundaries).
func (s *Server) getPlanningContext(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")
	if ok, err := s.requireGreenhouse(ctx, c, id); !ok {
		return err
	}
	window, interval, verr := parsePlanningParams(c)
	if verr != nil {
		return respondValidation(c, verr)
	}
	// The window is anchored to the greenhouse's latest stored (simulated) timestamp, not the
	// caller's wall clock — telemetry is stamped on the controller's clock, so a wall-clock
	// window could ask for an instant the simulation never reached.
	from, to, hasData, err := s.anchorWindow(ctx, id, planningWindowToDuration[window])
	if err != nil {
		return s.fail(c, err)
	}

	var buckets []store.AnalyticsRow
	var freshness []store.FreshnessRow
	var actuators []domain.ActuatorSample
	if hasData {
		if buckets, err = s.store.Analytics(ctx, id, from, to, nil, planningIntervalToSQL[interval]); err != nil {
			return s.fail(c, err)
		}
		if freshness, err = s.store.MetricFreshness(ctx, id, from, to); err != nil {
			return s.fail(c, err)
		}
		if actuators, err = s.store.LatestActuators(ctx, id, from, to); err != nil {
			return s.fail(c, err)
		}
	}

	setpoints, err := s.planningSetpoints(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	snapshot, _ := s.fleet.Snapshot(id)

	return c.JSON(http.StatusOK, planningContextDTO{
		GreenhouseID:  id,
		SchemaVersion: planningContextSchemaVersion,
		From:          fmtTS(from),
		To:            fmtTS(to),
		Interval:      interval,
		Setpoints:     setpoints,
		Telemetry:     groupSummaries(buckets),
		Actuators:     mapActuatorSnapshots(actuators, snapshot),
		DataQuality: dataQualityDTO{
			ControllerMode: controllerMode(snapshot),
			TimeScale:      s.liveFields(id).TimeScale,
			Freshness:      mapFreshness(freshness, to),
			Faults:         mapSensorFaults(snapshot),
		},
	})
}

// parsePlanningParams reads the optional window/interval enums, defaulting to the optimizer's
// 12-hour horizon at hourly buckets. An unknown value is a 422, per the contract.
func parsePlanningParams(c echo.Context) (string, string, *valError) {
	window := c.QueryParam("window")
	if window == "" {
		window = "12h"
	}
	if _, ok := planningWindowToDuration[window]; !ok {
		return "", "", &valError{Field: "window", Bound: "6h|12h|24h|48h", Value: window}
	}
	interval := c.QueryParam("interval")
	if interval == "" {
		interval = "1h"
	}
	if _, ok := planningIntervalToSQL[interval]; !ok {
		return "", "", &valError{Field: "interval", Bound: "1h|6h|1d", Value: interval}
	}
	return window, interval, nil
}

// planningSetpoints resolves the crop-safe baseline the optimizer refines against: the
// greenhouse's current intended state with its provenance, plus the active profile stage's
// envelope. When no revision exists yet the reconciler seeds a baseline from the controller's
// reported setpoints, reported with "profile" provenance — it is the resolved bundle in
// force, not an optimizer or operator write.
func (s *Server) planningSetpoints(ctx context.Context, id string) (currentSetpointsDTO, error) {
	bounds, err := s.resolveStageBounds(ctx, id)
	if err != nil {
		return currentSetpointsDTO{}, err
	}
	current, found, err := s.store.CurrentRevision(ctx, id)
	if err != nil {
		return currentSetpointsDTO{}, err
	}
	if found {
		return currentSetpointsDTO{
			Source:    string(current.Source),
			UpdatedAt: fmtTS(current.CreatedAt),
			Targets:   current.Setpoints,
			Bounds:    bounds,
		}, nil
	}
	baseline, err := s.reconcile.Baseline(ctx, id)
	if err != nil {
		return currentSetpointsDTO{}, err
	}
	return currentSetpointsDTO{
		Source:    string(domain.SourceProfile),
		UpdatedAt: fmtTS(time.Now()),
		Targets:   baseline,
		Bounds:    bounds,
	}, nil
}

// groupSummaries collapses the store's ordered aggregate rows into per-(metric, zone) series,
// renaming the store's avg to the contract's mean.
func groupSummaries(rows []store.AnalyticsRow) []metricSummarySeriesDTO {
	series := make([]metricSummarySeriesDTO, 0)
	current := -1
	for _, row := range rows {
		if current < 0 || series[current].Metric != row.Metric || zoneKey(series[current].ZoneID) != zoneKey(row.ZoneID) {
			series = append(series, metricSummarySeriesDTO{Metric: row.Metric, ZoneID: row.ZoneID, Buckets: []summaryBucketDTO{}})
			current = len(series) - 1
		}
		series[current].Buckets = append(series[current].Buckets, summaryBucketDTO{
			BucketStart: fmtTS(row.BucketStart),
			Min:         row.Min,
			Mean:        row.Avg,
			Max:         row.Max,
			Count:       row.Count,
		})
	}
	return series
}

// mapActuatorSnapshots joins each stored latest position with its readback health from the
// live controller snapshot. Health is never stored (it is a current-state signal, not
// history), so an actuator the snapshot has not seen reports the healthy default.
func mapActuatorSnapshots(samples []domain.ActuatorSample, snapshot state.ControllerSnapshot) []actuatorSnapshotDTO {
	snapshots := make([]actuatorSnapshotDTO, 0, len(samples))
	for _, sample := range samples {
		health := defaultActuatorHealth
		if reported, ok := snapshot.ActuatorHealth[state.ActuatorKey{Actuator: sample.Actuator, ZoneID: zoneKey(sample.ZoneID)}]; ok {
			health = reported
		}
		snapshots = append(snapshots, actuatorSnapshotDTO{
			Actuator:  sample.Actuator,
			ZoneID:    sample.ZoneID,
			Commanded: sample.Commanded,
			Observed:  sample.Observed,
			Health:    health,
			TS:        fmtTS(sample.TS),
		})
	}
	return snapshots
}

// mapFreshness reports each metric/scope's recency against the window's end — the same
// (simulated) clock the readings are stamped on, so an age is never distorted by the gap
// between simulated and wall-clock time. A metric with no samples in the window is absent
// rather than null-aged; the optimizer treats that absence as a completeness concern.
func mapFreshness(rows []store.FreshnessRow, to time.Time) []metricFreshnessDTO {
	freshness := make([]metricFreshnessDTO, 0, len(rows))
	for _, row := range rows {
		latest := fmtTS(row.LatestTS)
		age := to.Sub(row.LatestTS).Seconds()
		if age < 0 {
			age = 0
		}
		freshness = append(freshness, metricFreshnessDTO{
			Metric:      row.Metric,
			ZoneID:      row.ZoneID,
			LatestTS:    &latest,
			AgeSeconds:  &age,
			SampleCount: row.SampleCount,
		})
	}
	return freshness
}

// controllerMode reports the last-observed operating mode. A greenhouse that has published no
// state frame yet is reported "normal": the mode is a fault signal, and its absence is not
// evidence of degradation — staleness is the freshness gate's concern, not this field's.
func controllerMode(snapshot state.ControllerSnapshot) string {
	if snapshot.Mode == "" {
		return "normal"
	}
	return snapshot.Mode
}

// mapSensorFaults renders the live active sensor-fault set, ordered by metric then zone so
// the response is stable across cycles (the snapshot is a map).
func mapSensorFaults(snapshot state.ControllerSnapshot) []sensorFaultDTO {
	faults := make([]sensorFaultDTO, 0, len(snapshot.SensorFaults))
	for key, fault := range snapshot.SensorFaults {
		var zone *string
		if key.ZoneID != "" {
			zoneID := key.ZoneID
			zone = &zoneID
		}
		faults = append(faults, sensorFaultDTO{
			Metric: key.Component,
			ZoneID: zone,
			Kind:   fault.Kind,
			Since:  fmtTS(fault.Since),
		})
	}
	sort.Slice(faults, func(i, j int) bool {
		if faults[i].Metric != faults[j].Metric {
			return faults[i].Metric < faults[j].Metric
		}
		return zoneKey(faults[i].ZoneID) < zoneKey(faults[j].ZoneID)
	})
	return faults
}
