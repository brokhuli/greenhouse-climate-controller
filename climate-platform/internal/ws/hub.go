package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// subscriberBuffer bounds each subscriber's outgoing queue; a subscriber that cannot
// keep up has its oldest frames dropped rather than stalling the hub (a transport
// problem degrades one view, never the whole fan-out).
const subscriberBuffer = 128

// Hub is the single broadcast multiplexer: one goroutine per connected subscriber reads
// from its bounded send channel; Broadcast fans a frame out to all of them.
type Hub struct {
	mu          sync.RWMutex
	subscribers map[*subscriber]struct{}
	log         *slog.Logger
}

// subscriber is one connected dashboard WebSocket.
type subscriber struct {
	send chan []byte
}

// NewHub builds an empty hub.
func NewHub(log *slog.Logger) *Hub {
	return &Hub{subscribers: make(map[*subscriber]struct{}), log: log}
}

// Broadcast marshals a frame and sends it to every connected subscriber. A subscriber
// whose buffer is full has this frame dropped (never blocks the hub).
func (h *Hub) Broadcast(frame any) {
	data, err := json.Marshal(frame)
	if err != nil {
		h.log.Error("ws: marshal frame", "err", err)
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for sub := range h.subscribers {
		select {
		case sub.send <- data:
		default:
			// Slow subscriber: shed this frame for it.
		}
	}
}

// Handle upgrades an HTTP request to a WebSocket and serves frames until the subscriber
// disconnects. Mount it on the live channel route.
func (h *Hub) Handle(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Trusted local Docker network (RFC-011); no cross-origin concern in 2a.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	defer conn.CloseNow() //nolint:errcheck // best-effort close on exit

	sub := &subscriber{send: make(chan []byte, subscriberBuffer)}
	h.add(sub)
	defer h.remove(sub)

	// CloseRead drains (and discards) any subscriber messages — the channel is push-only —
	// and cancels ctx when the peer goes away.
	ctx := conn.CloseRead(r.Context())
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-sub.send:
			writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := conn.Write(writeCtx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

// Clients returns the current connected-subscriber count (used by tests/metrics).
func (h *Hub) Clients() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subscribers)
}

func (h *Hub) add(sub *subscriber) {
	h.mu.Lock()
	h.subscribers[sub] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) remove(sub *subscriber) {
	h.mu.Lock()
	delete(h.subscribers, sub)
	h.mu.Unlock()
}
