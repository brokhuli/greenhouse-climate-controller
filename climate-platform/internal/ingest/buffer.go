package ingest

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// record is one item queued for the database writer; exactly one field is set.
type record struct {
	reading  *domain.Reading
	actuator *domain.ActuatorSample
	event    *domain.Event
}

// writer is the bounded buffer between MQTT receipt and the time-series write
// (ingestion §6). It is decoupled from the DB the same way the controller decouples
// publishing from its tick: a stall in the write path sheds the oldest queued frames
// rather than growing without bound.
type writer struct {
	ch      chan record
	dropped atomic.Int64
	store   readingSink
	log     *slog.Logger
}

// readingSink is the subset of the store the writer needs (kept small for testing).
type readingSink interface {
	InsertReadings(ctx context.Context, readings []domain.Reading) error
	InsertActuators(ctx context.Context, samples []domain.ActuatorSample) error
	InsertEvent(ctx context.Context, event domain.Event) error
}

func newWriter(size int, store readingSink, log *slog.Logger) *writer {
	if size < 1 {
		size = 1
	}
	return &writer{ch: make(chan record, size), store: store, log: log}
}

// push enqueues a record, dropping the oldest queued frame when the buffer is full so
// the producer never blocks (bounded, shed-oldest).
func (w *writer) push(rec record) {
	for {
		select {
		case w.ch <- rec:
			return
		default:
			select {
			case <-w.ch:
				w.dropped.Add(1)
			default:
			}
		}
	}
}

// Dropped reports how many frames have been shed under backpressure (lag signal).
func (w *writer) Dropped() int64 { return w.dropped.Load() }

const (
	maxBatch   = 256
	flushEvery = 500 * time.Millisecond
)

// run drains the buffer, batching readings and actuators and writing events
// individually, until ctx is cancelled.
func (w *writer) run(ctx context.Context) {
	ticker := time.NewTicker(flushEvery)
	defer ticker.Stop()

	var readings []domain.Reading
	var actuators []domain.ActuatorSample
	flush := func() {
		if len(readings) > 0 {
			if err := w.store.InsertReadings(ctx, readings); err != nil {
				w.log.Error("ingest: write readings", "err", err, "n", len(readings))
			}
			readings = readings[:0]
		}
		if len(actuators) > 0 {
			if err := w.store.InsertActuators(ctx, actuators); err != nil {
				w.log.Error("ingest: write actuators", "err", err, "n", len(actuators))
			}
			actuators = actuators[:0]
		}
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return
		case <-ticker.C:
			flush()
		case rec := <-w.ch:
			switch {
			case rec.reading != nil:
				readings = append(readings, *rec.reading)
			case rec.actuator != nil:
				actuators = append(actuators, *rec.actuator)
			case rec.event != nil:
				if err := w.store.InsertEvent(ctx, *rec.event); err != nil {
					w.log.Error("ingest: write event", "err", err)
				}
			}
			if len(readings)+len(actuators) >= maxBatch {
				flush()
			}
		}
	}
}
