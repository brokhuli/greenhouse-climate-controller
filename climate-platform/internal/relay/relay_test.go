package relay

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDoPassesThroughStatusBodyAndAuth(t *testing.T) {
	var gotAuth, gotMethod, gotPath, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotMethod = r.Method
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"error":"bad","field":"temperature_day_c","bound":"-20..60"}`))
	}))
	defer srv.Close()

	tok := "secret"
	resp, err := New(2*time.Second).Do(context.Background(), http.MethodPatch, srv.URL, "/setpoints", &tok, []byte(`{"temperature_day_c":99}`))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Status != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", resp.Status)
	}
	if string(resp.Body) != `{"error":"bad","field":"temperature_day_c","bound":"-20..60"}` {
		t.Fatalf("body not passed through: %s", resp.Body)
	}
	if gotAuth != "Bearer secret" || gotMethod != http.MethodPatch || gotPath != "/setpoints" || gotBody != `{"temperature_day_c":99}` {
		t.Fatalf("request not forwarded faithfully: auth=%q method=%q path=%q body=%q", gotAuth, gotMethod, gotPath, gotBody)
	}
}

func TestDoUnreachableIsError(t *testing.T) {
	// Port 1 is reserved/closed — the dial fails fast, distinct from an HTTP status.
	_, err := New(300*time.Millisecond).Do(context.Background(), http.MethodGet, "http://127.0.0.1:1", "/health", nil, nil)
	if err == nil {
		t.Fatal("expected transport error for unreachable controller")
	}
}
