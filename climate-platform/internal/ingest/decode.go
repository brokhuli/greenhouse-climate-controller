package ingest

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// envelopePayload is the RFC-007 envelope every MQTT message carries.
type envelopePayload struct {
	SchemaVersion int     `json:"schema_version"`
	GreenhouseID  string  `json:"greenhouse_id"`
	ZoneID        *string `json:"zone_id"`
	TS            string  `json:"ts"`
}

func (e envelopePayload) time() (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339, e.TS)
	if err != nil {
		return time.Time{}, fmt.Errorf("bad ts %q: %w", e.TS, err)
	}
	return parsed.UTC(), nil
}

// --- sensor reading (gh/{id}/sensor/{metric}, gh/{id}/zone/{zone}/sensor/{metric}) ---

type sensorPayload struct {
	envelopePayload
	Metric string  `json:"metric"`
	Value  float64 `json:"value"`
	Unit   string  `json:"unit"`
}

func decodeReading(data []byte) (domain.Reading, error) {
	var payload sensorPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return domain.Reading{}, err
	}
	ts, err := payload.time()
	if err != nil {
		return domain.Reading{}, err
	}
	if !domain.Metrics[payload.Metric] {
		return domain.Reading{}, fmt.Errorf("unknown metric %q", payload.Metric)
	}
	return domain.Reading{
		GreenhouseID: payload.GreenhouseID,
		ZoneID:       payload.ZoneID,
		Metric:       payload.Metric,
		Value:        payload.Value,
		Unit:         payload.Unit,
		TS:           ts,
	}, nil
}

// --- actuator state (gh/{id}/actuator/{actuator}/state) ---

type actuatorOutput struct {
	On       bool     `json:"on"`
	LevelPct *float64 `json:"level_pct"`
}

// position flattens the {on, level_pct} shape to a 0–100 number: on/off devices report
// 0 (off) or 100 (on); variable devices report their level.
func (o actuatorOutput) position() float64 {
	if !o.On {
		return 0
	}
	if o.LevelPct != nil {
		return *o.LevelPct
	}
	return 100
}

type actuatorPayload struct {
	envelopePayload
	Actuator  string         `json:"actuator"`
	Commanded actuatorOutput `json:"commanded"`
	Observed  actuatorOutput `json:"observed"`
}

func decodeActuator(data []byte) (domain.ActuatorSample, error) {
	var payload actuatorPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return domain.ActuatorSample{}, err
	}
	ts, err := payload.time()
	if err != nil {
		return domain.ActuatorSample{}, err
	}
	if !domain.Actuators[payload.Actuator] {
		return domain.ActuatorSample{}, fmt.Errorf("unknown actuator %q", payload.Actuator)
	}
	observed := payload.Observed.position()
	return domain.ActuatorSample{
		GreenhouseID: payload.GreenhouseID,
		ZoneID:       payload.ZoneID,
		Actuator:     payload.Actuator,
		Commanded:    payload.Commanded.position(),
		Observed:     &observed,
		TS:           ts,
	}, nil
}

// --- fault event (gh/{id}/fault) ---

type faultPayload struct {
	envelopePayload
	Component string `json:"component"`
	FaultType string `json:"fault_type"`
	Severity  string `json:"severity"` // warning | alarm
	Message   string `json:"message"`
}

// interlockFaults are the safety-interlock triggers surfaced as kind "interlock".
var interlockFaults = map[string]bool{
	"critical_temperature":   true,
	"co2_ceiling":            true,
	"irrigation_no_response": true,
}

func decodeFault(data []byte) (domain.Event, error) {
	var payload faultPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return domain.Event{}, err
	}
	ts, err := payload.time()
	if err != nil {
		return domain.Event{}, err
	}
	kind := "fault"
	if interlockFaults[payload.FaultType] {
		kind = "interlock"
	}
	// Map the controller's warning/alarm to the platform's dashboard grading.
	severity := "warning"
	if payload.Severity == "alarm" {
		severity = "critical"
	}
	source := payload.Component
	if source == "" {
		source = "controller"
	}
	message := payload.Message
	if message == "" {
		message = payload.FaultType
	}
	return domain.Event{
		GreenhouseID: payload.GreenhouseID,
		TS:           ts,
		Kind:         kind,
		Severity:     severity,
		Message:      message,
		Source:       source,
	}, nil
}

// --- consolidated system state (retained gh/{id}/state) ---

type stateReading struct {
	Value float64 `json:"value"`
}

type systemStatePayload struct {
	envelopePayload
	Controller struct {
		Mode    string `json:"mode"`
		Healthy bool   `json:"healthy"`
	} `json:"controller"`
	Sensors struct {
		Temperature *stateReading `json:"temperature"`
		Humidity    *stateReading `json:"humidity"`
		CO2         *stateReading `json:"co2"`
	} `json:"sensors"`
	// DLI is a derived value carried alongside (not inside) sensors; it drives the fleet card.
	DLI        *stateReading `json:"dli"`
	Simulation *struct {
		TimeScale float64 `json:"time_scale"`
		TickIndex int64   `json:"tick_index"`
	} `json:"simulation"`
}

func decodeSystemState(data []byte) (systemStatePayload, time.Time, error) {
	var payload systemStatePayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return systemStatePayload{}, time.Time{}, err
	}
	ts, err := payload.time()
	if err != nil {
		return systemStatePayload{}, time.Time{}, err
	}
	return payload, ts, nil
}
