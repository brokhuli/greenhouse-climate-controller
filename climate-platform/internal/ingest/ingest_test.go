package ingest

import (
	"testing"
	"time"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
)

type fakeBroadcaster struct{ frames int }

func (f *fakeBroadcaster) Broadcast(_ any) { f.frames++ }

// newTestIngester builds an Ingester wired to in-memory fakes, bypassing New() (which
// dials MQTT). The given ids are seeded as registered/known.
func newTestIngester(known ...string) (*Ingester, *fakeBroadcaster) {
	hub := &fakeBroadcaster{}
	ing := &Ingester{
		fleet:        state.NewFleet(10 * time.Second),
		hub:          hub,
		metrics:      nopMetrics{},
		log:          discardLogger(),
		buf:          newWriter(8, &fakeSink{}, discardLogger()),
		offlineAfter: 10 * time.Second,
		known:        map[string]string{},
	}
	for _, id := range known {
		ing.known[id] = "gh/" + id
	}
	return ing, hub
}

const readingMatch = `{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","metric":"temperature","value":21.5,"unit":"°C"}`
const readingOtherID = `{"schema_version":1,"greenhouse_id":"gh-b","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","metric":"temperature","value":21.5,"unit":"°C"}`
const readingNoID = `{"schema_version":1,"greenhouse_id":"","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","metric":"temperature","value":21.5,"unit":"°C"}`
const readingHumidity = `{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","metric":"humidity","value":58.0,"unit":"%RH"}`
const readingHumidityZone = `{"schema_version":1,"greenhouse_id":"gh-a","zone_id":"bench-a","ts":"2026-06-07T14:03:00.000Z","metric":"humidity","value":58.0,"unit":"%RH"}`
const readingCO2 = `{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","metric":"co2","value":820.0,"unit":"ppm"}`
const readingPAR = `{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","metric":"par","value":412.0,"unit":"µmol·m⁻²·s⁻¹"}`

func TestReadingRejectsPayloadTopicMismatch(t *testing.T) {
	now := time.Now()
	for _, body := range []string{readingOtherID, readingNoID} {
		ing, hub := newTestIngester("gh-a")
		ing.onReading([]byte(body), "gh-a", now)
		if hub.frames != 0 || len(ing.buf.ch) != 0 {
			t.Fatalf("mismatched payload must be dropped: frames=%d buffered=%d (body=%s)", hub.frames, len(ing.buf.ch), body)
		}
		if _, ok := ing.fleet.Get("gh-b"); ok {
			t.Fatal("a foreign payload id must never enter fleet state")
		}
	}
}

func TestReadingAcceptsMatchingID(t *testing.T) {
	ing, hub := newTestIngester("gh-a")
	ing.onReading([]byte(readingMatch), "gh-a", time.Now())
	if hub.frames == 0 || len(ing.buf.ch) != 1 {
		t.Fatalf("matching payload must be stored and broadcast: frames=%d buffered=%d", hub.frames, len(ing.buf.ch))
	}
}

const actuatorMatch = `{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","actuator":"heater","commanded":{"on":true,"level_pct":50.0},"observed":{"on":true,"level_pct":50.0}}`
const faultMatch = `{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","component":"temperature","fault_type":"out_of_range","severity":"warning","message":"test"}`

// countingMetrics records recorder calls so tests can assert ingest instrumentation fires.
type countingMetrics struct {
	streams     map[string]int
	transitions map[string]int
}

func newCountingMetrics() *countingMetrics {
	return &countingMetrics{streams: map[string]int{}, transitions: map[string]int{}}
}

func (c *countingMetrics) IngestMessage(stream string)          { c.streams[stream]++ }
func (c *countingMetrics) ConnectivityTransition(status string) { c.transitions[status]++ }

func TestMetricsRecordedPerStream(t *testing.T) {
	ing, _ := newTestIngester("gh-a")
	rec := newCountingMetrics()
	ing.metrics = rec
	now := time.Now()

	ing.onReading([]byte(readingMatch), "gh-a", now)   // reading + first-contact online transition
	ing.onActuator([]byte(actuatorMatch), "gh-a", now) // actuator
	ing.onFault([]byte(faultMatch), "gh-a", now)       // event + degraded transition
	ing.onState([]byte(stateMatch), "gh-a", now)       // state

	for stream, want := range map[string]int{"reading": 1, "actuator": 1, "event": 1, "state": 1} {
		if rec.streams[stream] != want {
			t.Errorf("IngestMessage(%q) = %d, want %d", stream, rec.streams[stream], want)
		}
	}
	// The first reading brings gh-a online; the fault degrades it — both are transitions.
	if rec.transitions["online"] < 1 || rec.transitions["degraded"] < 1 {
		t.Errorf("connectivity transitions not recorded: %+v", rec.transitions)
	}
}

func TestHouseReadingsDriveFleetTiles(t *testing.T) {
	ing, _ := newTestIngester("gh-a")
	now := time.Now()
	ing.onReading([]byte(readingMatch), "gh-a", now)    // temperature 21.5
	ing.onReading([]byte(readingHumidity), "gh-a", now) // humidity 58
	ing.onReading([]byte(readingCO2), "gh-a", now)      // co2 820
	ing.onReading([]byte(readingPAR), "gh-a", now)      // par 412 — ingested for history/WS, not a house tile
	live, ok := ing.fleet.Get("gh-a")
	if !ok || live.Temperature == nil || *live.Temperature != 21.5 {
		t.Fatalf("house temperature not recorded: %+v", live)
	}
	if live.Humidity == nil || *live.Humidity != 58 {
		t.Fatalf("house humidity not recorded: %+v", live)
	}
	if live.CO2 == nil || *live.CO2 != 820 {
		t.Fatalf("house co2 not recorded: %+v", live)
	}
	// PAR is a per-tick sensor (history + live stream) but is no longer a fleet tile; the card's
	// light metric is DLI, which arrives via the system-state snapshot (see TestStateSnapshotRecordsHouseSensors).
	if live.DLI != nil {
		t.Fatalf("a per-tick par reading must not set a fleet tile: %+v", live)
	}
}

func TestZoneReadingDoesNotDriveHouseTiles(t *testing.T) {
	ing, _ := newTestIngester("gh-a")
	ing.onReading([]byte(readingHumidityZone), "gh-a", time.Now())
	if live, _ := ing.fleet.Get("gh-a"); live.Humidity != nil {
		t.Fatalf("a zone reading must not set the house humidity tile: %+v", live)
	}
}

const stateMatch = `{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","controller":{"mode":"normal","healthy":true},"sensors":{"temperature":{"value":21.5}}}`
const stateOtherID = `{"schema_version":1,"greenhouse_id":"gh-b","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","controller":{"mode":"normal","healthy":true},"sensors":{"temperature":{"value":21.5}}}`
const stateWithHumidity = `{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","controller":{"mode":"normal","healthy":true},"sensors":{"temperature":{"value":21.5},"humidity":{"value":62.0},"co2":{"value":840.0},"par":{"value":355.0}},"dli":{"value":18.2,"unit":"mol·m⁻²·d⁻¹"}}`

func TestStateRejectsPayloadTopicMismatch(t *testing.T) {
	now := time.Now()
	ing, hub := newTestIngester("gh-a")

	ing.onState([]byte(stateOtherID), "gh-a", now)
	if hub.frames != 0 {
		t.Fatalf("mismatched state must be dropped, got %d frames", hub.frames)
	}
	if _, ok := ing.fleet.Get("gh-b"); ok {
		t.Fatal("a foreign payload id must never enter fleet state")
	}

	ing.onState([]byte(stateMatch), "gh-a", now)
	if hub.frames == 0 {
		t.Fatal("matching state must broadcast a status frame")
	}
}

func TestStateSnapshotRecordsHouseSensors(t *testing.T) {
	ing, _ := newTestIngester("gh-a")
	ing.onState([]byte(stateWithHumidity), "gh-a", time.Now())
	live, ok := ing.fleet.Get("gh-a")
	if !ok || live.Humidity == nil || *live.Humidity != 62 {
		t.Fatalf("state snapshot humidity not recorded: %+v", live)
	}
	if live.CO2 == nil || *live.CO2 != 840 {
		t.Fatalf("state snapshot co2 not recorded: %+v", live)
	}
	if live.DLI == nil || *live.DLI != 18.2 {
		t.Fatalf("state snapshot dli not recorded: %+v", live)
	}
}

func TestSweepInterval(t *testing.T) {
	// Sized to the fastest accepted clock: 10s / (2 * MaxTimeScale) with MaxTimeScale=8.
	if got := sweepInterval(10 * time.Second); got != 625*time.Millisecond {
		t.Fatalf("sweepInterval(10s) = %v, want 625ms", got)
	}
	// A tiny horizon floors to minSweepInterval rather than spinning.
	if got := sweepInterval(2 * time.Second); got != minSweepInterval {
		t.Fatalf("sweepInterval(2s) = %v, want floor %v", got, minSweepInterval)
	}
	// The cadence must not exceed the fastest greenhouse's effective horizon.
	offlineAfter := 16 * time.Second
	fastestHorizon := time.Duration(float64(offlineAfter) / domain.MaxTimeScale)
	if got := sweepInterval(offlineAfter); got > fastestHorizon {
		t.Fatalf("sweep %v must not lag the 8x horizon %v", got, fastestHorizon)
	}
}
