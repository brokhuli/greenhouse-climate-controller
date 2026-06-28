package api

import (
	"testing"
	"time"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/state"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
)

func TestSummaryOfIncludesLiveClimate(t *testing.T) {
	fleet := state.NewFleet(10 * time.Second)
	now := time.Now()
	fleet.Observe("gh-a", now)
	temp, hum, co2, par := 23.4, 58.0, 820.0, 412.0
	fleet.SetTemperature("gh-a", &temp)
	fleet.SetHumidity("gh-a", &hum)
	fleet.SetCO2("gh-a", &co2)
	fleet.SetPAR("gh-a", &par)

	s := &Server{fleet: fleet}
	summary := s.summaryOf(store.Greenhouse{ID: "gh-a", DisplayName: "Greenhouse A"})

	if summary.Climate.Temperature == nil || *summary.Climate.Temperature != 23.4 {
		t.Fatalf("temperature not in summary: %+v", summary.Climate)
	}
	if summary.Climate.Humidity == nil || *summary.Climate.Humidity != 58 {
		t.Fatalf("humidity not in summary: %+v", summary.Climate)
	}
	if summary.Climate.CO2 == nil || *summary.Climate.CO2 != 820 {
		t.Fatalf("co2 not in summary: %+v", summary.Climate)
	}
	if summary.Climate.PAR == nil || *summary.Climate.PAR != 412 {
		t.Fatalf("par not in summary: %+v", summary.Climate)
	}
	// Setpoints are not wired into the fleet summary yet (deferred).
	if summary.Climate.SetpointTemperature != nil {
		t.Fatalf("setpoint should be nil until wired, got %v", *summary.Climate.SetpointTemperature)
	}
}

func TestSummaryOfOfflineWhenUnknown(t *testing.T) {
	s := &Server{fleet: state.NewFleet(10 * time.Second)}
	summary := s.summaryOf(store.Greenhouse{ID: "gh-x", DisplayName: "X"})
	if summary.Status != "offline" {
		t.Fatalf("unknown greenhouse should be offline, got %s", summary.Status)
	}
	if summary.Climate.Temperature != nil || summary.Climate.Humidity != nil {
		t.Fatalf("offline greenhouse should have nil climate: %+v", summary.Climate)
	}
}
