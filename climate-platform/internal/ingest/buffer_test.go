package ingest

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

type fakeSink struct {
	readings  int
	actuators int
	events    int
}

func (f *fakeSink) InsertReadings(_ context.Context, rs []domain.Reading) error {
	f.readings += len(rs)
	return nil
}
func (f *fakeSink) InsertActuators(_ context.Context, as []domain.ActuatorSample) error {
	f.actuators += len(as)
	return nil
}
func (f *fakeSink) InsertEvent(_ context.Context, _ domain.Event) error {
	f.events++
	return nil
}

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestBufferDropsOldestWhenFull(t *testing.T) {
	w := newWriter(2, &fakeSink{}, discardLogger())
	for n := 0; n < 5; n++ {
		msg := "x"
		w.push(record{event: &domain.Event{Message: msg}})
	}
	if got := w.Dropped(); got != 3 {
		t.Fatalf("dropped = %d, want 3 (cap 2, pushed 5)", got)
	}
}

func TestWriterFlushesToStore(t *testing.T) {
	sink := &fakeSink{}
	w := newWriter(64, sink, discardLogger())
	ctx, cancel := context.WithCancel(context.Background())
	go w.run(ctx)

	zone := "bench-a"
	w.push(record{reading: &domain.Reading{GreenhouseID: "gh-a", Metric: "temperature", Value: 20}})
	w.push(record{actuator: &domain.ActuatorSample{GreenhouseID: "gh-a", Actuator: "fans", ZoneID: &zone}})
	w.push(record{event: &domain.Event{GreenhouseID: "gh-a", Kind: "fault"}})

	// Wait for the periodic flush (500ms) to drain the buffer.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if sink.readings == 1 && sink.actuators == 1 && sink.events == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	if sink.readings != 1 || sink.actuators != 1 || sink.events != 1 {
		t.Fatalf("store got readings=%d actuators=%d events=%d", sink.readings, sink.actuators, sink.events)
	}
}
