package api

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
)

// intervalToSQL maps the contract's analytics interval enum to a PostgreSQL interval.
var intervalToSQL = map[string]string{
	"5m":  "5 minutes",
	"15m": "15 minutes",
	"1h":  "1 hour",
	"6h":  "6 hours",
	"1d":  "1 day",
}

// windowToDuration maps the contract's history-window enum to a duration. The window is resolved
// server-side against each greenhouse's latest stored (simulated) timestamp — see anchorWindow and
// store.FleetSparklines — so a browser wall clock never decides which rows a chart asks for.
var windowToDuration = map[string]time.Duration{
	"15m": 15 * time.Minute,
	"30m": 30 * time.Minute,
	"1h":  time.Hour,
	"6h":  6 * time.Hour,
	"24h": 24 * time.Hour,
}

func (s *Server) getTelemetry(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")
	if ok, err := s.requireGreenhouse(ctx, c, id); !ok {
		return err
	}
	window, verr := parseWindowParam(c)
	if verr != nil {
		return respondValidation(c, verr)
	}
	from, to, hasData, err := s.anchorWindow(ctx, id, window)
	if err != nil {
		return s.fail(c, err)
	}
	var readings []domain.Reading
	var actuators []domain.ActuatorSample
	if hasData {
		if readings, actuators, err = s.store.TelemetryRange(ctx, id, from, to); err != nil {
			return s.fail(c, err)
		}
	}
	return c.JSON(http.StatusOK, telemetryRangeDTO{
		GreenhouseID: id,
		From:         fmtTS(from),
		To:           fmtTS(to),
		Series:       groupSeries(readings),
		Actuators:    mapActuators(actuators),
	})
}

func (s *Server) getAnalytics(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")
	if ok, err := s.requireGreenhouse(ctx, c, id); !ok {
		return err
	}
	window, verr := parseWindowParam(c)
	if verr != nil {
		return respondValidation(c, verr)
	}
	var metric *string
	if metricParam := c.QueryParam("metric"); metricParam != "" {
		if !domain.Metrics[metricParam] {
			return respondValidation(c, &valError{Field: "metric", Bound: "known metric", Value: metricParam})
		}
		metric = &metricParam
	}
	interval := c.QueryParam("interval")
	if interval == "" {
		interval = "1h"
	}
	intervalSQL, ok := intervalToSQL[interval]
	if !ok {
		return respondValidation(c, &valError{Field: "interval", Bound: "5m|15m|1h|6h|1d", Value: interval})
	}
	from, to, hasData, err := s.anchorWindow(ctx, id, window)
	if err != nil {
		return s.fail(c, err)
	}
	var rows []store.AnalyticsRow
	if hasData {
		if rows, err = s.store.Analytics(ctx, id, from, to, metric, intervalSQL); err != nil {
			return s.fail(c, err)
		}
	}
	return c.JSON(http.StatusOK, analyticsResponseDTO{
		GreenhouseID: id,
		From:         fmtTS(from),
		To:           fmtTS(to),
		Interval:     interval,
		Series:       groupAnalytics(rows),
	})
}

// getFleetSparklines returns recent house-level history for every greenhouse in one batched query,
// so the fleet-overview cards can seed their charts on init without N requests (one per card).
func (s *Server) getFleetSparklines(c echo.Context) error {
	ctx := c.Request().Context()
	window, verr := parseWindowParam(c)
	if verr != nil {
		return respondValidation(c, verr)
	}
	metric := c.QueryParam("metric")
	if metric == "" {
		metric = "temperature"
	}
	if !domain.Metrics[metric] {
		return respondValidation(c, &valError{Field: "metric", Bound: "known metric", Value: metric})
	}
	rows, err := s.store.FleetSparklines(ctx, intervalLiteral(window), metric, sparklineBucketSQL(window))
	if err != nil {
		return s.fail(c, err)
	}
	from, to := sparklineBounds(rows)
	return c.JSON(http.StatusOK, fleetSparklinesDTO{
		From:   fmtTS(from),
		To:     fmtTS(to),
		Metric: metric,
		Series: groupFleetSparklines(rows),
	})
}

// sparklineBucketSQL picks a time_bucket width targeting ~40 points across the window, clamped to
// [10s, 600s], as a PostgreSQL interval literal — fine enough for a card sparkline yet coarse enough
// to stay light across the whole fleet (the analytics interval enum bottoms out at 5m, too coarse).
func sparklineBucketSQL(window time.Duration) string {
	const target = 40
	seconds := int(window.Seconds()) / target
	if seconds < 10 {
		seconds = 10
	}
	if seconds > 600 {
		seconds = 600
	}
	return strconv.Itoa(seconds) + " seconds"
}

// groupFleetSparklines collapses the store's greenhouse-ordered rows into per-greenhouse series.
func groupFleetSparklines(rows []store.FleetSparklineRow) []greenhouseSparklineDTO {
	series := make([]greenhouseSparklineDTO, 0)
	current := -1
	for _, row := range rows {
		if current < 0 || series[current].GreenhouseID != row.GreenhouseID {
			series = append(series, greenhouseSparklineDTO{GreenhouseID: row.GreenhouseID, Readings: []readingDTO{}})
			current = len(series) - 1
		}
		series[current].Readings = append(series[current].Readings, readingDTO{Value: row.Avg, TS: fmtTS(row.BucketStart)})
	}
	return series
}

// requireGreenhouse returns ok=false (with a 404 already written) when id is unknown.
func (s *Server) requireGreenhouse(ctx context.Context, c echo.Context, id string) (bool, error) {
	exists, err := s.store.Exists(ctx, id)
	if err != nil {
		return false, s.fail(c, err)
	}
	if !exists {
		return false, respondNotFound(c, "greenhouse not found")
	}
	return true, nil
}

// parseWindowParam reads the optional history-window enum, defaulting to 1h. The window is a
// trailing duration; the server anchors it to stored data (anchorWindow / FleetSparklines), so —
// unlike a from/to wall-clock window — it cannot ask for an instant the simulation never reached.
func parseWindowParam(c echo.Context) (time.Duration, *valError) {
	window := c.QueryParam("window")
	if window == "" {
		window = "1h"
	}
	duration, ok := windowToDuration[window]
	if !ok {
		return 0, &valError{Field: "window", Bound: "15m|30m|1h|6h|24h", Value: window}
	}
	return duration, nil
}

// anchorWindow resolves a trailing window against one greenhouse's latest stored timestamp:
// [maxTs-window, maxTs]. hasData is false when the greenhouse has no readings yet (from/to are then
// the zero time and the caller returns an empty series).
func (s *Server) anchorWindow(ctx context.Context, id string, window time.Duration) (time.Time, time.Time, bool, error) {
	maxTS, ok, err := s.store.LatestReadingTS(ctx, id)
	if err != nil || !ok {
		return time.Time{}, time.Time{}, ok, err
	}
	return maxTS.Add(-window).UTC(), maxTS.UTC(), true, nil
}

// intervalLiteral renders a window duration as a PostgreSQL interval literal (whole seconds).
func intervalLiteral(window time.Duration) string {
	return strconv.Itoa(int(window.Seconds())) + " seconds"
}

// sparklineBounds reports the min/max bucket timestamps across every greenhouse's rows — the
// bounding window echoed back to the client (per-greenhouse anchoring means there is no single
// from/to). Both are the zero time when there are no rows.
func sparklineBounds(rows []store.FleetSparklineRow) (time.Time, time.Time) {
	var from, to time.Time
	for i, row := range rows {
		if i == 0 || row.BucketStart.Before(from) {
			from = row.BucketStart
		}
		if i == 0 || row.BucketStart.After(to) {
			to = row.BucketStart
		}
	}
	return from, to
}

func zoneKey(zone *string) string {
	if zone == nil {
		return ""
	}
	return *zone
}

// groupSeries collapses the store's ordered readings into per-(metric, zone) series.
func groupSeries(readings []domain.Reading) []telemetrySeriesDTO {
	series := make([]telemetrySeriesDTO, 0)
	current := -1
	for _, reading := range readings {
		if current < 0 || series[current].Metric != reading.Metric || zoneKey(series[current].ZoneID) != zoneKey(reading.ZoneID) {
			series = append(series, telemetrySeriesDTO{Metric: reading.Metric, ZoneID: reading.ZoneID, Readings: []readingDTO{}})
			current = len(series) - 1
		}
		series[current].Readings = append(series[current].Readings, readingDTO{Value: reading.Value, TS: fmtTS(reading.TS)})
	}
	return series
}

func groupAnalytics(rows []store.AnalyticsRow) []analyticsSeriesDTO {
	series := make([]analyticsSeriesDTO, 0)
	current := -1
	for _, row := range rows {
		if current < 0 || series[current].Metric != row.Metric || zoneKey(series[current].ZoneID) != zoneKey(row.ZoneID) {
			series = append(series, analyticsSeriesDTO{Metric: row.Metric, ZoneID: row.ZoneID, Buckets: []analyticsBucketDTO{}})
			current = len(series) - 1
		}
		series[current].Buckets = append(series[current].Buckets, analyticsBucketDTO{
			BucketStart: fmtTS(row.BucketStart),
			Min:         row.Min,
			Max:         row.Max,
			Avg:         row.Avg,
			Count:       row.Count,
		})
	}
	return series
}

func mapActuators(samples []domain.ActuatorSample) []actuatorStateDTO {
	states := make([]actuatorStateDTO, 0, len(samples))
	for _, sample := range samples {
		states = append(states, actuatorStateDTO{
			Actuator:  sample.Actuator,
			ZoneID:    sample.ZoneID,
			Commanded: sample.Commanded,
			Observed:  sample.Observed,
			TS:        fmtTS(sample.TS),
		})
	}
	return states
}
