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

const stateMatch = `{"schema_version":1,"greenhouse_id":"gh-a","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","controller":{"mode":"normal","healthy":true},"sensors":{"temperature":{"value":21.5}}}`
const stateOtherID = `{"schema_version":1,"greenhouse_id":"gh-b","zone_id":null,"ts":"2026-06-07T14:03:00.000Z","controller":{"mode":"normal","healthy":true},"sensors":{"temperature":{"value":21.5}}}`

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
