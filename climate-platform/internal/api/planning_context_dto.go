package api

import "github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"

// Wire shapes for the Phase 3 planning-context read
// (contracts/platform-optimizer-planning-rest). Every object there is
// additionalProperties:false and lists its nullable fields as required, so nothing here
// carries omitempty — an absent field would fail the optimizer's own response validation.

// planningContextDTO is one bounded read of a greenhouse's planning context: current
// setpoints, bucketed telemetry history, latest actuator states, and the data-quality
// signals the optimizer's input gate runs before planning.
type planningContextDTO struct {
	GreenhouseID string `json:"greenhouse_id"`
	// SchemaVersion is the drift signal the optimizer's identity-consistency check reads; it
	// tracks the contract's info.version major.
	SchemaVersion int                      `json:"schema_version"`
	From          string                   `json:"from"`
	To            string                   `json:"to"`
	Interval      string                   `json:"interval"`
	Setpoints     currentSetpointsDTO      `json:"setpoints"`
	Telemetry     []metricSummarySeriesDTO `json:"telemetry"`
	Actuators     []actuatorSnapshotDTO    `json:"actuators"`
	DataQuality   dataQualityDTO           `json:"data_quality"`
}

// currentSetpointsDTO is the greenhouse's intended state with its provenance, plus the
// active stage's crop-safe envelope the optimizer must refine within. Bounds is omitted
// when the greenhouse has no assignment or its stage defines no envelope — the one
// genuinely optional field in this contract.
type currentSetpointsDTO struct {
	Source    string              `json:"source"`
	UpdatedAt string              `json:"updated_at"`
	Targets   domain.Setpoints    `json:"targets"`
	Bounds    *domain.StageBounds `json:"bounds,omitempty"`
}

type summaryBucketDTO struct {
	BucketStart string  `json:"bucket_start"`
	Min         float64 `json:"min"`
	Mean        float64 `json:"mean"`
	Max         float64 `json:"max"`
	// Count is the raw samples aggregated into the bucket; 0 marks it a gap. Bucket coverage
	// across the window is the optimizer's completeness signal.
	Count int64 `json:"count"`
}

type metricSummarySeriesDTO struct {
	Metric  string             `json:"metric"`
	ZoneID  *string            `json:"zone_id"`
	Buckets []summaryBucketDTO `json:"buckets"`
}

type actuatorSnapshotDTO struct {
	Actuator  string   `json:"actuator"`
	ZoneID    *string  `json:"zone_id"`
	Commanded float64  `json:"commanded"`
	Observed  *float64 `json:"observed"`
	Health    string   `json:"health"`
	TS        string   `json:"ts"`
}

type metricFreshnessDTO struct {
	Metric string  `json:"metric"`
	ZoneID *string `json:"zone_id"`
	// LatestTS / AgeSeconds are null when the window holds no sample for this metric/scope.
	LatestTS    *string  `json:"latest_ts"`
	AgeSeconds  *float64 `json:"age_seconds"`
	SampleCount int64    `json:"sample_count"`
}

type sensorFaultDTO struct {
	Metric string  `json:"metric"`
	ZoneID *string `json:"zone_id"`
	Kind   string  `json:"kind"`
	Since  string  `json:"since"`
}

// dataQualityDTO carries the input gate's preconditions. TimeScale is null on real
// hardware; a simulated greenhouse reporting anything but 1.0 holds the cycle, since the
// optimizer's wall-clock cadence is out of its operating envelope off 1×.
type dataQualityDTO struct {
	ControllerMode string               `json:"controller_mode"`
	TimeScale      *float64             `json:"time_scale"`
	Freshness      []metricFreshnessDTO `json:"freshness"`
	Faults         []sensorFaultDTO     `json:"faults"`
}
