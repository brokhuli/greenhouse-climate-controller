package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// InsertReadings writes a batch of sensor samples.
func (s *Store) InsertReadings(ctx context.Context, readings []domain.Reading) error {
	if len(readings) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, reading := range readings {
		batch.Queue(
			`INSERT INTO sensor_readings (ts, greenhouse_id, zone_id, metric, value, unit) VALUES ($1,$2,$3,$4,$5,$6)`,
			reading.TS, reading.GreenhouseID, reading.ZoneID, reading.Metric, reading.Value, reading.Unit)
	}
	return s.sendBatch(ctx, batch, len(readings))
}

// InsertActuators writes a batch of actuator samples.
func (s *Store) InsertActuators(ctx context.Context, samples []domain.ActuatorSample) error {
	if len(samples) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, sample := range samples {
		batch.Queue(
			`INSERT INTO actuator_states (ts, greenhouse_id, zone_id, actuator, commanded, observed) VALUES ($1,$2,$3,$4,$5,$6)`,
			sample.TS, sample.GreenhouseID, sample.ZoneID, sample.Actuator, sample.Commanded, sample.Observed)
	}
	return s.sendBatch(ctx, batch, len(samples))
}

// InsertEvent writes one activity-feed event (also the platform's audit sink).
func (s *Store) InsertEvent(ctx context.Context, event domain.Event) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO events (ts, greenhouse_id, kind, severity, message, source) VALUES ($1,$2,$3,$4,$5,$6)`,
		event.TS, event.GreenhouseID, event.Kind, event.Severity, event.Message, event.Source)
	return err
}

func (s *Store) sendBatch(ctx context.Context, batch *pgx.Batch, count int) error {
	results := s.pool.SendBatch(ctx, batch)
	defer func() { _ = results.Close() }()
	for i := 0; i < count; i++ {
		if _, err := results.Exec(); err != nil {
			return err
		}
	}
	return nil
}

// TelemetryRange returns the raw sensor samples and actuator samples for one
// greenhouse over [from, to], ordered for grouping into the contract series.
func (s *Store) TelemetryRange(ctx context.Context, greenhouseID string, from, to time.Time) ([]domain.Reading, []domain.ActuatorSample, error) {
	readings, err := s.rangeReadings(ctx, greenhouseID, from, to)
	if err != nil {
		return nil, nil, err
	}
	actuators, err := s.rangeActuators(ctx, greenhouseID, from, to)
	if err != nil {
		return nil, nil, err
	}
	return readings, actuators, nil
}

func (s *Store) rangeReadings(ctx context.Context, greenhouseID string, from, to time.Time) ([]domain.Reading, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT metric, zone_id, value, unit, ts FROM sensor_readings
		 WHERE greenhouse_id=$1 AND ts >= $2 AND ts <= $3
		 ORDER BY metric, zone_id NULLS FIRST, ts`, greenhouseID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var readings []domain.Reading
	for rows.Next() {
		reading := domain.Reading{GreenhouseID: greenhouseID}
		var zone pgtype.Text
		if err := rows.Scan(&reading.Metric, &zone, &reading.Value, &reading.Unit, &reading.TS); err != nil {
			return nil, err
		}
		reading.ZoneID = textPtr(zone)
		readings = append(readings, reading)
	}
	return readings, rows.Err()
}

func (s *Store) rangeActuators(ctx context.Context, greenhouseID string, from, to time.Time) ([]domain.ActuatorSample, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT actuator, zone_id, commanded, observed, ts FROM actuator_states
		 WHERE greenhouse_id=$1 AND ts >= $2 AND ts <= $3
		 ORDER BY ts`, greenhouseID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var samples []domain.ActuatorSample
	for rows.Next() {
		sample := domain.ActuatorSample{GreenhouseID: greenhouseID}
		var zone pgtype.Text
		var observed pgtype.Float8
		if err := rows.Scan(&sample.Actuator, &zone, &sample.Commanded, &observed, &sample.TS); err != nil {
			return nil, err
		}
		sample.ZoneID = textPtr(zone)
		if observed.Valid {
			value := observed.Float64
			sample.Observed = &value
		}
		samples = append(samples, sample)
	}
	return samples, rows.Err()
}

// AnalyticsRow is one time-bucket aggregate of a metric/zone series.
type AnalyticsRow struct {
	Metric      string
	ZoneID      *string
	BucketStart time.Time
	Min         float64
	Max         float64
	Avg         float64
	Count       int64
}

// Analytics returns time-bucketed min/max/avg/count aggregates for one greenhouse over
// [from, to]. intervalSQL is a PostgreSQL interval literal (e.g. "5 minutes"); metric,
// when non-nil, restricts the result to one metric.
func (s *Store) Analytics(ctx context.Context, greenhouseID string, from, to time.Time, metric *string, intervalSQL string) ([]AnalyticsRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT metric, zone_id,
		        time_bucket($1::interval, ts) AS bucket_start,
		        min(value) AS min, max(value) AS max, avg(value) AS avg, count(*) AS count
		 FROM sensor_readings
		 WHERE greenhouse_id=$2 AND ts >= $3 AND ts <= $4
		   AND ($5::text IS NULL OR metric = $5)
		 GROUP BY metric, zone_id, bucket_start
		 ORDER BY metric, zone_id NULLS FIRST, bucket_start`,
		intervalSQL, greenhouseID, from, to, metric)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var aggregates []AnalyticsRow
	for rows.Next() {
		var row AnalyticsRow
		var zone pgtype.Text
		if err := rows.Scan(&row.Metric, &zone, &row.BucketStart, &row.Min, &row.Max, &row.Avg, &row.Count); err != nil {
			return nil, err
		}
		row.ZoneID = textPtr(zone)
		aggregates = append(aggregates, row)
	}
	return aggregates, rows.Err()
}

// LatestReadingTS returns the most recent reading timestamp for one greenhouse, anchoring a
// history window to stored (simulated) time rather than the caller's wall clock. ok is false when
// the greenhouse has no readings yet.
func (s *Store) LatestReadingTS(ctx context.Context, greenhouseID string) (time.Time, bool, error) {
	var latest pgtype.Timestamptz
	err := s.pool.QueryRow(ctx,
		`SELECT max(ts) FROM sensor_readings WHERE greenhouse_id=$1`, greenhouseID).Scan(&latest)
	if err != nil {
		return time.Time{}, false, err
	}
	if !latest.Valid {
		return time.Time{}, false, nil
	}
	return latest.Time, true, nil
}

// FleetSparklineRow is one greenhouse's bucketed average for one house-level metric, used to seed
// the fleet-overview cards' charts in one query instead of one per (card, metric).
type FleetSparklineRow struct {
	GreenhouseID string
	Metric       string
	BucketStart  time.Time
	Avg          float64
}

// FleetSparklines returns time-bucketed averages of the requested house-level metrics (zone_id IS
// NULL) for every greenhouse, anchored per (greenhouse, metric) to that pair's own latest reading:
// the trailing windowSQL up to its max(ts). Anchoring per metric (not just per greenhouse) keeps
// each card sparkline filled even if metrics report at different cadences. Anchoring to stored
// (simulated) time — not a wall-clock window — is what lets the fleet cards seed their charts from
// data the simulation clock has actually produced. windowSQL and intervalSQL are PostgreSQL
// interval literals (e.g. "3600 seconds", "90 seconds"). Rows are ordered by (greenhouse, metric)
// for grouping into per-greenhouse, per-metric series.
func (s *Store) FleetSparklines(ctx context.Context, windowSQL string, metrics []string, intervalSQL string) ([]FleetSparklineRow, error) {
	rows, err := s.pool.Query(ctx,
		`WITH latest AS (
		        SELECT greenhouse_id, metric, max(ts) AS max_ts
		        FROM sensor_readings
		        WHERE metric = ANY($2::text[]) AND zone_id IS NULL
		        GROUP BY greenhouse_id, metric)
		 SELECT r.greenhouse_id,
		        r.metric,
		        time_bucket($1::interval, r.ts) AS bucket_start,
		        avg(r.value) AS avg
		 FROM sensor_readings r
		 JOIN latest l USING (greenhouse_id, metric)
		 WHERE r.metric = ANY($2::text[]) AND r.zone_id IS NULL
		   AND r.ts > l.max_ts - $3::interval AND r.ts <= l.max_ts
		 GROUP BY r.greenhouse_id, r.metric, bucket_start
		 ORDER BY r.greenhouse_id, r.metric, bucket_start`,
		intervalSQL, metrics, windowSQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var sparklines []FleetSparklineRow
	for rows.Next() {
		var row FleetSparklineRow
		if err := rows.Scan(&row.GreenhouseID, &row.Metric, &row.BucketStart, &row.Avg); err != nil {
			return nil, err
		}
		sparklines = append(sparklines, row)
	}
	return sparklines, rows.Err()
}

// EventFilter narrows the activity feed. All fields are optional.
type EventFilter struct {
	GreenhouseID *string
	Kind         *string
	MinSeverity  *string // info < warning < critical
}

// ListEvents returns recent events (newest first) matching the filter.
func (s *Store) ListEvents(ctx context.Context, filter EventFilter) ([]domain.Event, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT greenhouse_id, ts, kind, severity, message, source FROM events
		 WHERE ($1::text IS NULL OR greenhouse_id = $1)
		   AND ($2::text IS NULL OR kind = $2)
		   AND ($3::text IS NULL OR
		        (CASE severity WHEN 'critical' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END) >=
		        (CASE $3       WHEN 'critical' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END))
		 ORDER BY ts DESC
		 LIMIT 500`, filter.GreenhouseID, filter.Kind, filter.MinSeverity)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []domain.Event
	for rows.Next() {
		var event domain.Event
		if err := rows.Scan(&event.GreenhouseID, &event.TS, &event.Kind, &event.Severity, &event.Message, &event.Source); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}
