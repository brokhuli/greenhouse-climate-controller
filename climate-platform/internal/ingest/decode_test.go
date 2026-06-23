package ingest

import "testing"

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
	p, ts, err := decodeSystemState([]byte(`{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","controller":{"mode":"normal","healthy":true},"sensors":{"temperature":{"value":21.5,"unit":"°C"},"humidity":null,"co2":null,"par":null,"vpd":null},"zones":[],"actuators":[],"faults":[],"overrides":[],"simulation":{"time_scale":2.0,"tick_index":42}}`))
	if err != nil {
		t.Fatal(err)
	}
	if ts.IsZero() || p.Sensors.Temperature == nil || p.Sensors.Temperature.Value != 21.5 {
		t.Fatalf("temperature not parsed: %+v", p)
	}
	if p.Simulation == nil || p.Simulation.TimeScale != 2.0 {
		t.Fatalf("simulation not parsed: %+v", p.Simulation)
	}
	if !p.Controller.Healthy || p.Controller.Mode != "normal" {
		t.Fatalf("controller not parsed: %+v", p.Controller)
	}
}
