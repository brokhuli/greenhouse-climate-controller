package api

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/ws"
)

// TestStreamWebSocket verifies the Echo route hands off cleanly to the coder/websocket
// hub (the hijack path) and that a broadcast frame reaches a connected client.
func TestStreamWebSocket(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := ws.NewHub(logger)
	srv := New(nil, nil, nil, nil, nil, hub, nil, logger)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/api/stream"
	conn, resp, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// Wait until the hub has registered this client, then broadcast.
	for i := 0; i < 100 && hub.Clients() == 0; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	hub.Broadcast(ws.NewStatus("gh-a", time.Now(), domain.StatusOnline, nil))

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.Contains(string(data), `"type":"status"`) || !strings.Contains(string(data), `"greenhouse_id":"gh-a"`) {
		t.Fatalf("unexpected frame: %s", data)
	}
}
