package ingest

import (
	"context"
	"log/slog"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ws"
)

// Broadcaster receives marshal-ready WS frames; the ws.Hub satisfies it.
type Broadcaster interface {
	Broadcast(frame any)
}

// Ingester subscribes to controller telemetry, routes it by greenhouse, persists it
// through the bounded buffer, maintains the live fleet state, and fans frames out to
// the dashboard over the WebSocket hub.
type Ingester struct {
	fleet        *state.Fleet
	hub          Broadcaster
	log          *slog.Logger
	buf          *writer
	client       mqtt.Client
	offlineAfter time.Duration

	mu    sync.RWMutex
	known map[string]string // greenhouse_id -> mqtt topic root
}

// New builds an ingester. sink is the time-series store the buffer writes to; the
// registry of known greenhouses is seeded via Add/Remove (and Seed at startup).
func New(sink readingSink, fleet *state.Fleet, hub Broadcaster, log *slog.Logger, brokerURL string, bufferSize int, offlineAfter time.Duration) *Ingester {
	ing := &Ingester{
		fleet:        fleet,
		hub:          hub,
		log:          log,
		buf:          newWriter(bufferSize, sink, log),
		offlineAfter: offlineAfter,
		known:        make(map[string]string),
	}
	opts := mqtt.NewClientOptions().
		AddBroker(brokerURL).
		SetClientID("platform-ingester").
		SetCleanSession(true).
		SetAutoReconnect(true).
		SetConnectRetry(true).
		SetOnConnectHandler(ing.onConnect).
		SetConnectionLostHandler(func(_ mqtt.Client, err error) {
			log.Warn("ingest: broker connection lost", "err", err)
		})
	ing.client = mqtt.NewClient(opts)
	return ing
}

// Dropped reports frames shed under backpressure (lag signal).
func (ing *Ingester) Dropped() int64 { return ing.buf.Dropped() }

// Seed pre-populates the known-greenhouse set (called once at startup with the registry).
func (ing *Ingester) Seed(topicRoots map[string]string) {
	ing.mu.Lock()
	defer ing.mu.Unlock()
	for id, root := range topicRoots {
		ing.known[id] = root
	}
}

// Add registers a greenhouse so its telemetry is accepted (called on REST registration).
func (ing *Ingester) Add(greenhouseID, topicRoot string) {
	ing.mu.Lock()
	ing.known[greenhouseID] = topicRoot
	ing.mu.Unlock()
}

// Remove stops accepting a greenhouse's telemetry, drops its live state, and clears the
// retained system-state snapshot from the broker (the one platform-originated publish —
// broker housekeeping, not a control write; ingestion §7).
func (ing *Ingester) Remove(greenhouseID string) {
	ing.mu.Lock()
	root := ing.known[greenhouseID]
	delete(ing.known, greenhouseID)
	ing.mu.Unlock()
	ing.fleet.Remove(greenhouseID)
	if root != "" && ing.client.IsConnected() {
		token := ing.client.Publish(root+"/state", 1, true, []byte{})
		if !token.WaitTimeout(2*time.Second) || token.Error() != nil {
			ing.log.Warn("ingest: clear retained state", "id", greenhouseID, "err", token.Error())
		}
	}
}

func (ing *Ingester) isKnown(id string) bool {
	ing.mu.RLock()
	defer ing.mu.RUnlock()
	_, ok := ing.known[id]
	return ok
}

// Start connects to the broker and launches the writer and liveness goroutines. It
// returns once connected; teardown follows ctx.
func (ing *Ingester) Start(ctx context.Context) error {
	go ing.buf.run(ctx)
	go ing.runLiveness(ctx)
	token := ing.client.Connect()
	if token.Wait() && token.Error() != nil {
		return token.Error()
	}
	go func() {
		<-ctx.Done()
		ing.client.Disconnect(250)
	}()
	return nil
}

func (ing *Ingester) onConnect(client mqtt.Client) {
	// Wildcard-subscribe to the whole fleet (ingestion §2). Resubscribes on reconnect;
	// the retained gh/{id}/state snapshot replays current state immediately.
	if token := client.Subscribe("gh/+/#", 1, ing.handleMessage); token.Wait() && token.Error() != nil {
		ing.log.Error("ingest: subscribe", "err", token.Error())
		return
	}
	ing.log.Info("ingest: subscribed", "filter", "gh/+/#")
}

func (ing *Ingester) handleMessage(_ mqtt.Client, msg mqtt.Message) {
	info, ok := parseTopic(msg.Topic())
	if !ok {
		return
	}
	if !ing.isKnown(info.greenhouseID) {
		ing.log.Warn("ingest: dropping telemetry for unregistered greenhouse", "id", info.greenhouseID, "topic", msg.Topic())
		return
	}
	now := time.Now()
	switch info.kind {
	case topicSensorHouse, topicSensorZone:
		ing.onReading(msg.Payload(), info.greenhouseID, now)
	case topicActuator:
		ing.onActuator(msg.Payload(), info.greenhouseID, now)
	case topicFault:
		ing.onFault(msg.Payload(), info.greenhouseID, now)
	case topicState:
		ing.onState(msg.Payload(), info.greenhouseID, now)
	}
}

// mismatched drops (and logs) telemetry whose envelope greenhouse_id disagrees with the
// topic it arrived on — topic and payload are one identity, no translation layer
// (contracts/mqtt; ingestion §2). Routing is by the registry-validated topic id, so a
// payload claiming a different (or empty) id is rejected rather than silently stored.
func (ing *Ingester) mismatched(topicID, payloadID string) bool {
	if payloadID == topicID {
		return false
	}
	ing.log.Warn("ingest: dropping telemetry, payload greenhouse_id disagrees with topic",
		"topic_id", topicID, "payload_id", payloadID)
	return true
}

func (ing *Ingester) onReading(payload []byte, topicID string, now time.Time) {
	reading, err := decodeReading(payload)
	if err != nil {
		ing.log.Warn("ingest: bad sensor reading", "err", err)
		return
	}
	if ing.mismatched(topicID, reading.GreenhouseID) {
		return
	}
	ing.buf.push(record{reading: &reading})
	if reading.ZoneID == nil {
		switch reading.Metric {
		case "temperature":
			temperature := reading.Value
			ing.fleet.SetTemperature(reading.GreenhouseID, &temperature)
		case "humidity":
			humidity := reading.Value
			ing.fleet.SetHumidity(reading.GreenhouseID, &humidity)
		}
	}
	live, changed := ing.fleet.Observe(reading.GreenhouseID, now)
	ing.hub.Broadcast(ws.NewTelemetryReading(reading))
	if changed {
		ing.hub.Broadcast(ws.NewStatus(reading.GreenhouseID, reading.TS, live.Status, live.TimeScale))
	}
}

func (ing *Ingester) onActuator(payload []byte, topicID string, now time.Time) {
	sample, err := decodeActuator(payload)
	if err != nil {
		ing.log.Warn("ingest: bad actuator state", "err", err)
		return
	}
	if ing.mismatched(topicID, sample.GreenhouseID) {
		return
	}
	ing.buf.push(record{actuator: &sample})
	live, changed := ing.fleet.Observe(sample.GreenhouseID, now)
	ing.hub.Broadcast(ws.NewTelemetryActuator(sample))
	if changed {
		ing.hub.Broadcast(ws.NewStatus(sample.GreenhouseID, sample.TS, live.Status, live.TimeScale))
	}
}

func (ing *Ingester) onFault(payload []byte, topicID string, now time.Time) {
	event, err := decodeFault(payload)
	if err != nil {
		ing.log.Warn("ingest: bad fault event", "err", err)
		return
	}
	if ing.mismatched(topicID, event.GreenhouseID) {
		return
	}
	ing.buf.push(record{event: &event})
	live, changed := ing.fleet.SetDegraded(event.GreenhouseID, true, now)
	ing.hub.Broadcast(ws.NewEvent(event))
	if changed {
		ing.hub.Broadcast(ws.NewStatus(event.GreenhouseID, event.TS, live.Status, live.TimeScale))
	}
}

func (ing *Ingester) onState(payload []byte, topicID string, now time.Time) {
	snapshot, ts, err := decodeSystemState(payload)
	if err != nil {
		ing.log.Warn("ingest: bad system state", "err", err)
		return
	}
	if ing.mismatched(topicID, snapshot.GreenhouseID) {
		return
	}
	var scale *float64
	if snapshot.Simulation != nil {
		scaleValue := snapshot.Simulation.TimeScale
		scale = &scaleValue
	}
	_, scaleChanged := ing.fleet.SetTimeScale(snapshot.GreenhouseID, scale)
	if snapshot.Sensors.Temperature != nil {
		temperature := snapshot.Sensors.Temperature.Value
		ing.fleet.SetTemperature(snapshot.GreenhouseID, &temperature)
	}
	if snapshot.Sensors.Humidity != nil {
		humidity := snapshot.Sensors.Humidity.Value
		ing.fleet.SetHumidity(snapshot.GreenhouseID, &humidity)
	}
	degraded := !snapshot.Controller.Healthy || snapshot.Controller.Mode != "normal"
	live, statusChanged := ing.fleet.SetDegraded(snapshot.GreenhouseID, degraded, now)
	if statusChanged || scaleChanged {
		ing.hub.Broadcast(ws.NewStatus(snapshot.GreenhouseID, ts, live.Status, live.TimeScale))
	}
}

// minSweepInterval floors the liveness cadence so a tiny offlineAfter can't spin the
// sweep into a busy loop.
const minSweepInterval = 250 * time.Millisecond

// sweepInterval sizes the liveness sweep to the fastest accepted clock: an N×
// greenhouse's effective offline horizon is offlineAfter/N (state.effectiveOffline), so
// sweeping at offlineAfter/(2·MaxTimeScale) marks even an 8× greenhouse offline within
// ~one cadence of its horizon instead of lagging the 1× cadence (ingestion §4).
func sweepInterval(offlineAfter time.Duration) time.Duration {
	interval := time.Duration(float64(offlineAfter) / (2 * domain.MaxTimeScale))
	if interval < minSweepInterval {
		interval = minSweepInterval
	}
	return interval
}

func (ing *Ingester) runLiveness(ctx context.Context) {
	ticker := time.NewTicker(sweepInterval(ing.offlineAfter))
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			for id, live := range ing.fleet.Sweep(now) {
				ing.hub.Broadcast(ws.NewStatus(id, now, live.Status, live.TimeScale))
			}
		}
	}
}
