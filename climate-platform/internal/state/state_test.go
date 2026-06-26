package state

import (
	"testing"
	"time"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

func fp(v float64) *float64 { return &v }

func TestObserveOnlineThenOffline(t *testing.T) {
	f := NewFleet(10 * time.Second)
	t0 := time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC)

	live, changed := f.Observe("gh-a", t0)
	if !changed || live.Status != domain.StatusOnline {
		t.Fatalf("first observe: changed=%v status=%s", changed, live.Status)
	}
	if got := f.Sweep(t0.Add(5 * time.Second)); len(got) != 0 {
		t.Fatalf("should still be online at 5s, got changes %v", got)
	}
	got := f.Sweep(t0.Add(11 * time.Second))
	if live, ok := got["gh-a"]; !ok || live.Status != domain.StatusOffline {
		t.Fatalf("should be offline at 11s, got %v", got)
	}
}

func TestTimeScaleStretchesOfflineWindow(t *testing.T) {
	f := NewFleet(10 * time.Second)
	t0 := time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC)
	f.Observe("gh-a", t0)
	f.SetTimeScale("gh-a", fp(0.25)) // effective offline = 10s / 0.25 = 40s

	if got := f.Sweep(t0.Add(20 * time.Second)); len(got) != 0 {
		t.Fatalf("0.25x greenhouse should not be offline at 20s, got %v", got)
	}
	if _, ok := f.Sweep(t0.Add(41 * time.Second))["gh-a"]; !ok {
		t.Fatal("0.25x greenhouse should be offline at 41s")
	}
}

func TestDegradedTransitions(t *testing.T) {
	f := NewFleet(10 * time.Second)
	t0 := time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC)
	f.Observe("gh-a", t0)

	if live, _ := f.SetDegraded("gh-a", true, t0); live.Status != domain.StatusDegraded {
		t.Fatalf("want degraded, got %s", live.Status)
	}
	if live, changed := f.SetDegraded("gh-a", false, t0); !changed || live.Status != domain.StatusOnline {
		t.Fatalf("want online after clear, changed=%v status=%s", changed, live.Status)
	}
}

func TestTemperatureHumidityAndRemove(t *testing.T) {
	f := NewFleet(10 * time.Second)
	t0 := time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC)
	f.Observe("gh-a", t0)
	f.SetTemperature("gh-a", fp(21.5))
	f.SetHumidity("gh-a", fp(58))
	live, _ := f.Get("gh-a")
	if live.Temperature == nil || *live.Temperature != 21.5 {
		t.Fatalf("temperature not recorded: %+v", live)
	}
	if live.Humidity == nil || *live.Humidity != 58 {
		t.Fatalf("humidity not recorded: %+v", live)
	}
	f.Remove("gh-a")
	if _, ok := f.Get("gh-a"); ok {
		t.Fatal("expected gh-a removed")
	}
}
