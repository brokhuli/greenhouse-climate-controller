package ingest

import (
	"testing"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
)

func TestDecodeReading(t *testing.T) {
	r, err := decodeReading([]byte(`{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","metric":"temperature","value":22.4,"unit":"°C"}`))
	if err != nil {
		t.Fatal(err)
	}
	if r.GreenhouseID != "gh-a" || r.ZoneID != nil || r.Metric != "temperature" || r.Value != 22.4 || r.Unit != "°C" {
		t.Fatalf("unexpected reading: %+v", r)
	}
	if r.TS.IsZero() {
		t.Fatal("ts not parsed")
	}
}

func TestDecodeReading_ZoneScoped(t *testing.T) {
	r, err := decodeReading([]byte(`{"schema_version":1,"greenhouse_id":"gh-a","zone_id":"bench-a","ts":"2026-06-07T14:03:00.000Z","metric":"soil_moisture","value":0.42,"unit":"VWC"}`))
	if err != nil {
		t.Fatal(err)
	}
	if r.ZoneID == nil || *r.ZoneID != "bench-a" {
		t.Fatalf("zone not parsed: %+v", r)
	}
}

func TestDecodeReading_BadMetric(t *testing.T) {
	if _, err := decodeReading([]byte(`{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","metric":"pressure","value":1,"unit":"x"}`)); err == nil {
		t.Fatal("expected unknown-metric error")
	}
}

func TestDecodeActuator_Variable(t *testing.T) {
	a, err := decodeActuator([]byte(`{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","actuator":"fans","commanded":{"on":true,"level_pct":60},"observed":{"on":true,"level_pct":58},"health":"ok","overridden":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if a.Actuator != "fans" || a.Commanded != 60 || a.Observed == nil || *a.Observed != 58 {
		t.Fatalf("unexpected actuator: %+v", a)
	}
}

func TestDecodeActuator_OnOffFlatten(t *testing.T) {
	a, err := decodeActuator([]byte(`{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","actuator":"misters","commanded":{"on":true,"level_pct":null},"observed":{"on":false,"level_pct":null},"health":"ok","overridden":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if a.Commanded != 100 || a.Observed == nil || *a.Observed != 0 {
		t.Fatalf("on/off flatten wrong: commanded=%v observed=%v", a.Commanded, a.Observed)
	}
}

func TestDecodeActuator_CarriesHealth(t *testing.T) {
	a, err := decodeActuator([]byte(`{"schema_version":1,"greenhouse_id":"gh-a","zone_id":"bench-a","ts":"2026-06-07T14:03:00.000Z","actuator":"irrigation_valve","commanded":{"on":true,"level_pct":null},"observed":{"on":false,"level_pct":null},"health":"no_response","overridden":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if a.Health != "no_response" {
		t.Fatalf("health = %q, want no_response", a.Health)
	}
}

func TestDecodeFault_InterlockAndSeverity(t *testing.T) {
	e, err := decodeFault([]byte(`{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","component":"temperature","fault_type":"critical_temperature","severity":"alarm","message":"too hot","response":"opened vents"}`))
	if err != nil {
		t.Fatal(err)
	}
	if e.Kind != "interlock" || e.Severity != "critical" || e.Source != "temperature" || e.Message != "too hot" {
		t.Fatalf("unexpected event: %+v", e)
	}
}

func TestDecodeFault_GenericWarning(t *testing.T) {
	e, err := decodeFault([]byte(`{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","component":"humidity","fault_type":"stuck","severity":"warning","message":"frozen","response":"none"}`))
	if err != nil {
		t.Fatal(err)
	}
	if e.Kind != "fault" || e.Severity != "warning" {
		t.Fatalf("unexpected event: %+v", e)
	}
}

func TestDecodeSystemState(t *testing.T) {
	p, ts, err := decodeSystemState([]byte(`{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","controller":{"mode":"normal","healthy":true},"sensors":{"temperature":{"value":21.5,"unit":"°C"},"humidity":null,"co2":null,"par":null,"vpd":null},"dli":{"value":12.6,"unit":"mol·m⁻²·d⁻¹"},"zones":[],"actuators":[],"faults":[],"overrides":[],"simulation":{"time_scale":2.0,"tick_index":42}}`))
	if err != nil {
		t.Fatal(err)
	}
	if ts.IsZero() || p.Sensors.Temperature == nil || p.Sensors.Temperature.Value != 21.5 {
		t.Fatalf("temperature not parsed: %+v", p)
	}
	if p.DLI == nil || p.DLI.Value != 12.6 {
		t.Fatalf("dli not parsed: %+v", p)
	}
	if p.Simulation == nil || p.Simulation.TimeScale != 2.0 {
		t.Fatalf("simulation not parsed: %+v", p.Simulation)
	}
	if !p.Controller.Healthy || p.Controller.Mode != "normal" {
		t.Fatalf("controller not parsed: %+v", p.Controller)
	}
}

// The state frame's active fault set is the planning-context read's fault source, so only
// per-sensor faults on known metrics survive the projection; actuator, interlock, and
// fusion-only faults reach the optimizer by other routes.
func TestSensorFaultsFiltersToSensorFaults(t *testing.T) {
	p, _, err := decodeSystemState([]byte(`{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","controller":{"mode":"degraded","healthy":false},"sensors":{"temperature":null,"humidity":null,"co2":null,"par":null,"vpd":null},"dli":{"value":1.0,"unit":"mol·m⁻²·d⁻¹"},"zones":[],"actuators":[],"overrides":[],"faults":[
		{"component":"temperature","zone_id":null,"fault_type":"stuck","severity":"warning"},
		{"component":"soil_moisture","zone_id":"bench-a","fault_type":"out_of_range","severity":"warning"},
		{"component":"temperature","zone_id":null,"fault_type":"critical_temperature","severity":"alarm"},
		{"component":"irrigation_valve","zone_id":"bench-a","fault_type":"actuator_stuck","severity":"warning"}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	faults := sensorFaults(p)
	if len(faults) != 2 {
		t.Fatalf("expected 2 sensor faults, got %d: %v", len(faults), faults)
	}
	if got := faults[state.FaultKey{Component: "temperature"}]; got != "stuck" {
		t.Fatalf("house sensor fault = %q, want stuck", got)
	}
	if got := faults[state.FaultKey{Component: "soil_moisture", ZoneID: "bench-a"}]; got != "out_of_range" {
		t.Fatalf("zone sensor fault = %q, want out_of_range", got)
	}
}
