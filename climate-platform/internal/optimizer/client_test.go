package optimizer

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestForwardsAuthorizationOnMutations(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"enabled":false}`))
	}))
	defer srv.Close()

	client := New(srv.URL, time.Second)
	if _, err := client.SetEnabled(context.Background(), "Bearer op-token", EnableRequest{Enabled: false}); err != nil {
		t.Fatal(err)
	}
	// The caller's token rides upstream so the optimizer re-checks the operator role itself.
	if gotAuth != "Bearer op-token" {
		t.Fatalf("Authorization not forwarded: %q", gotAuth)
	}
}

func TestReadsAreUntokened(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"greenhouses":[],"rollup":{"backlog":0,"applied":0,"escalated":0,"extended":0,"oldest_open_escalation_age_seconds":null}}`))
	}))
	defer srv.Close()

	if _, err := New(srv.URL, time.Second).Fleet(context.Background()); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "" {
		t.Fatalf("read must be untokened, got %q", gotAuth)
	}
}

func TestNon2xxIsStatusError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"detail":"already planning"}`))
	}))
	defer srv.Close()

	_, err := New(srv.URL, time.Second).TriggerCycle(context.Background(), "gh-a", "", CycleRequest{})
	if StatusCode(err) != http.StatusConflict {
		t.Fatalf("expected a 409 StatusError, got %v (code %d)", err, StatusCode(err))
	}
}

func TestTransportFailureIsNotStatusError(t *testing.T) {
	// An unroutable base URL fails at transport, not with an HTTP status — StatusCode reports 0
	// so the handler layer distinguishes "unreachable" from "responded with an error".
	_, err := New("http://127.0.0.1:1", time.Second).Health(context.Background())
	if err == nil {
		t.Fatal("expected a transport error")
	}
	if StatusCode(err) != 0 {
		t.Fatalf("transport failure must not carry an HTTP status, got %d", StatusCode(err))
	}
}
