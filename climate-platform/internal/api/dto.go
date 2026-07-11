package api

import (
	"encoding/json"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// --- error bodies ---

type errorBody struct {
	Error string `json:"error"`
}

// validationBody mirrors the controller-rest ValidationError: it names the offending
// field and the violated bound, echoing the rejected value (RFC-005).
type validationBody struct {
	Error string `json:"error"`
	Field string `json:"field"`
	Bound string `json:"bound"`
	Value any    `json:"value,omitempty"`
}

// --- greenhouses ---

type controllerEndpointDTO struct {
	RESTBaseURL   string  `json:"rest_base_url"`
	MQTTTopicRoot string  `json:"mqtt_topic_root"`
	BearerToken   *string `json:"bearer_token"`
}

type registrationDTO struct {
	ID          string                `json:"id"`
	DisplayName string                `json:"display_name"`
	Crop        *string               `json:"crop"`
	Controller  controllerEndpointDTO `json:"controller"`
}

type climateDTO struct {
	Temperature *float64 `json:"temperature"`
	Humidity    *float64 `json:"humidity"`
	CO2         *float64 `json:"co2"`
	DLI         *float64 `json:"dli"`
}

type greenhouseSummaryDTO struct {
	ID          string     `json:"id"`
	DisplayName string     `json:"display_name"`
	Crop        *string    `json:"crop"`
	Status      string     `json:"status"`
	Drift       bool       `json:"drift"`
	TimeScale   *float64   `json:"time_scale,omitempty"`
	Climate     climateDTO `json:"climate"`
}

type greenhouseDetailDTO struct {
	ID          string          `json:"id"`
	DisplayName string          `json:"display_name"`
	Crop        *string         `json:"crop"`
	Status      string          `json:"status"`
	Drift       bool            `json:"drift"`
	TimeScale   *float64        `json:"time_scale,omitempty"`
	Setpoints   json.RawMessage `json:"setpoints"`
	ZoneStatus  []zoneStatusDTO `json:"zone_status"`
}

// --- setpoints (partial edit: decoded, validated, and merged onto the baseline bundle) ---

type zoneTargetsDTO struct {
	ZoneID                *string  `json:"zone_id"`
	MoistureLowThreshold  *float64 `json:"moisture_low_threshold"`
	MoistureHighThreshold *float64 `json:"moisture_high_threshold"`
	DrainPeriodSecs       *int     `json:"drain_period_secs"`
	Schedule              *string  `json:"schedule"`
}

type setpointsPatchDTO struct {
	TemperatureDayC              *float64         `json:"temperature_day_c"`
	TemperatureNightC            *float64         `json:"temperature_night_c"`
	DayStart                     *string          `json:"day_start"`
	DayEnd                       *string          `json:"day_end"`
	HumidityLowPct               *float64         `json:"humidity_low_pct"`
	HumidityHighPct              *float64         `json:"humidity_high_pct"`
	HumidityDeadbandPct          *float64         `json:"humidity_deadband_pct"`
	CO2TargetPpm                 *int             `json:"co2_target_ppm"`
	CO2VentInterlockThresholdPct *float64         `json:"co2_vent_interlock_threshold_pct"`
	VPDTargetKpa                 *float64         `json:"vpd_target_kpa"`
	DLITargetMol                 *float64         `json:"dli_target_mol"`
	Zones                        []zoneTargetsDTO `json:"zones"`
}

// --- crop profiles & assignment (2b) ---
//
// Responses reuse the domain types directly (domain.CropProfile / domain.Assignment): their
// JSON tags already match the frontend-rest contract, so no separate response DTO is needed.
// Requests decode into these DTOs so a partial patch can distinguish an absent field from a
// zero value.

// cropProfilePatchDTO is a partial profile update (frontend-rest CropProfilePatch): any subset
// of name/crop/stages. A present stages array replaces the stage set wholesale.
type cropProfilePatchDTO struct {
	Name   *string               `json:"name"`
	Crop   *string               `json:"crop"`
	Stages []domain.ProfileStage `json:"stages"`
}

// assignmentInputDTO assigns a profile/stage to the greenhouse named in the path
// (frontend-rest AssignmentInput); the greenhouse identity comes from the path, not the body.
type assignmentInputDTO struct {
	ProfileID string `json:"profile_id"`
	Stage     string `json:"stage"`
}

// --- telemetry ---

type readingDTO struct {
	Value float64 `json:"value"`
	TS    string  `json:"ts"`
}

type telemetrySeriesDTO struct {
	Metric   string       `json:"metric"`
	ZoneID   *string      `json:"zone_id"`
	Readings []readingDTO `json:"readings"`
}

type actuatorStateDTO struct {
	Actuator  string   `json:"actuator"`
	ZoneID    *string  `json:"zone_id"`
	Commanded float64  `json:"commanded"`
	Observed  *float64 `json:"observed"`
	TS        string   `json:"ts"`
}

type telemetryRangeDTO struct {
	GreenhouseID string               `json:"greenhouse_id"`
	From         string               `json:"from"`
	To           string               `json:"to"`
	Series       []telemetrySeriesDTO `json:"series"`
	Actuators    []actuatorStateDTO   `json:"actuators"`
}

// --- analytics ---

type analyticsBucketDTO struct {
	BucketStart string  `json:"bucket_start"`
	Min         float64 `json:"min"`
	Max         float64 `json:"max"`
	Avg         float64 `json:"avg"`
	Count       int64   `json:"count"`
}

type analyticsSeriesDTO struct {
	Metric  string               `json:"metric"`
	ZoneID  *string              `json:"zone_id"`
	Buckets []analyticsBucketDTO `json:"buckets"`
}

type analyticsResponseDTO struct {
	GreenhouseID string               `json:"greenhouse_id"`
	From         string               `json:"from"`
	To           string               `json:"to"`
	Interval     string               `json:"interval"`
	Series       []analyticsSeriesDTO `json:"series"`
}

// --- fleet sparklines ---

type greenhouseSparklineDTO struct {
	GreenhouseID string       `json:"greenhouse_id"`
	Readings     []readingDTO `json:"readings"`
}

type fleetSparklinesDTO struct {
	From   string                   `json:"from"`
	To     string                   `json:"to"`
	Metric string                   `json:"metric"`
	Series []greenhouseSparklineDTO `json:"series"`
}

// --- events ---

type eventEntryDTO struct {
	GreenhouseID string `json:"greenhouse_id"`
	TS           string `json:"ts"`
	Kind         string `json:"kind"`
	Severity     string `json:"severity"`
	Message      string `json:"message"`
	Source       string `json:"source,omitempty"`
}

// --- simulation time-scale ---

type timeScalePatchDTO struct {
	Scale *float64 `json:"scale"`
}

type fleetTimeScaleEntryDTO struct {
	GreenhouseID string   `json:"greenhouse_id"`
	Applied      bool     `json:"applied"`
	Scale        *float64 `json:"scale"`
	Detail       *string  `json:"detail"`
}

type fleetTimeScaleResultDTO struct {
	RequestedScale float64                  `json:"requested_scale"`
	Results        []fleetTimeScaleEntryDTO `json:"results"`
}
