package api

import (
	"context"
	"net/http"
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

func (s *Server) getTelemetry(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")
	if ok, err := s.requireGreenhouse(ctx, c, id); !ok {
		return err
	}
	from, to, verr := parseWindow(c)
	if verr != nil {
		return respondValidation(c, verr)
	}
	readings, actuators, err := s.store.TelemetryRange(ctx, id, from, to)
	if err != nil {
		return s.fail(c, err)
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
	from, to, verr := parseWindow(c)
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
	rows, err := s.store.Analytics(ctx, id, from, to, metric, intervalSQL)
	if err != nil {
		return s.fail(c, err)
	}
	return c.JSON(http.StatusOK, analyticsResponseDTO{
		GreenhouseID: id,
		From:         fmtTS(from),
		To:           fmtTS(to),
		Interval:     interval,
		Series:       groupAnalytics(rows),
	})
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

// parseWindow reads and validates the required from/to query window.
func parseWindow(c echo.Context) (time.Time, time.Time, *valError) {
	fromStr, toStr := c.QueryParam("from"), c.QueryParam("to")
	if fromStr == "" {
		return time.Time{}, time.Time{}, &valError{Field: "from", Bound: "required RFC3339 date-time", Value: nil}
	}
	from, err := time.Parse(time.RFC3339, fromStr)
	if err != nil {
		return time.Time{}, time.Time{}, &valError{Field: "from", Bound: "RFC3339 date-time", Value: fromStr}
	}
	if toStr == "" {
		return time.Time{}, time.Time{}, &valError{Field: "to", Bound: "required RFC3339 date-time", Value: nil}
	}
	to, err := time.Parse(time.RFC3339, toStr)
	if err != nil {
		return time.Time{}, time.Time{}, &valError{Field: "to", Bound: "RFC3339 date-time", Value: toStr}
	}
	if to.Before(from) {
		return time.Time{}, time.Time{}, &valError{Field: "to", Bound: "must be >= from", Value: toStr}
	}
	return from.UTC(), to.UTC(), nil
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
