package domain

import "testing"

func sampleSetpoints() Setpoints {
	return Setpoints{
		TemperatureDayC: 24, TemperatureNightC: 18,
		DayStart: "06:00", DayEnd: "20:00",
		HumidityLowPct: 55, HumidityHighPct: 80, HumidityDeadbandPct: 5,
		CO2TargetPPM: 900, CO2VentInterlockThresholdPct: 20,
		VPDTargetKPa: 1.0, DLITargetMol: 17,
		Zones: []ZoneTargets{
			{ZoneID: "bench-a", MoistureLowThreshold: 0.3, MoistureHighThreshold: 0.6, DrainPeriodSecs: 600, Schedule: "06:00,14:00"},
		},
	}
}

func TestSetpointsEqualWithinTolerance(t *testing.T) {
	a := sampleSetpoints()
	b := sampleSetpoints()
	b.TemperatureDayC += 1e-9 // sub-epsilon jitter from a JSON round-trip must not read as drift
	if !a.Equal(b) {
		t.Fatal("sub-epsilon difference should compare equal")
	}
}

func TestSetpointsEqualDetectsDrift(t *testing.T) {
	cases := map[string]func(*Setpoints){
		"temperature":   func(s *Setpoints) { s.TemperatureDayC = 25 },
		"co2":           func(s *Setpoints) { s.CO2TargetPPM = 1000 },
		"day window":    func(s *Setpoints) { s.DayEnd = "21:00" },
		"vpd":           func(s *Setpoints) { s.VPDTargetKPa = 1.2 },
		"zone moisture": func(s *Setpoints) { s.Zones[0].MoistureLowThreshold = 0.35 },
		"zone schedule": func(s *Setpoints) { s.Zones[0].Schedule = "07:00" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			a := sampleSetpoints()
			b := sampleSetpoints()
			mutate(&b)
			if a.Equal(b) {
				t.Fatalf("%s difference should be detected as drift", name)
			}
		})
	}
}

func TestSetpointsEqualZoneOrderIndependent(t *testing.T) {
	benchB := ZoneTargets{ZoneID: "bench-b", MoistureLowThreshold: 0.25, MoistureHighThreshold: 0.55, DrainPeriodSecs: 300, Schedule: "08:00"}
	a := sampleSetpoints()
	benchA := a.Zones[0]
	a.Zones = []ZoneTargets{benchA, benchB}
	b := sampleSetpoints()
	b.Zones = []ZoneTargets{benchB, benchA}
	if !a.Equal(b) {
		t.Fatal("zones should compare order-independently by zone_id")
	}
}

func TestSetpointsEqualZoneCountMismatch(t *testing.T) {
	a := sampleSetpoints()
	b := sampleSetpoints()
	b.Zones = nil
	if a.Equal(b) {
		t.Fatal("differing zone count should be drift")
	}
}

func TestSetpointsReconciled(t *testing.T) {
	// A global-only intended bundle (no zones) is reconciled by a controller that reports zones:
	// zone topology is controller-local, so unmanaged zones are not drift.
	intended := sampleSetpoints()
	intended.Zones = nil
	reported := sampleSetpoints() // controller has bench-a
	if !intended.Reconciled(reported) {
		t.Fatal("a global-only profile must not drift against a controller that reports zones")
	}
	// But global divergence is still drift.
	reportedWarm := reported
	reportedWarm.TemperatureDayC = 30
	if intended.Reconciled(reportedWarm) {
		t.Fatal("a global setpoint difference must be drift")
	}

	// A governed zone whose target differs on the controller is drift...
	governed := sampleSetpoints() // governs bench-a
	drifted := sampleSetpoints()
	drifted.Zones[0].MoistureLowThreshold = 0.45
	if governed.Reconciled(drifted) {
		t.Fatal("a governed zone's differing target must be drift")
	}
	// ...and a governed zone missing from the controller is drift.
	missing := sampleSetpoints()
	missing.Zones = nil
	if governed.Reconciled(missing) {
		t.Fatal("a governed zone absent on the controller must be drift")
	}
	// A governed zone that matches, alongside an extra unmanaged controller zone, reconciles.
	withExtra := sampleSetpoints()
	withExtra.Zones = append(withExtra.Zones, ZoneTargets{
		ZoneID: "seedling-tray", MoistureLowThreshold: 0.5, MoistureHighThreshold: 0.7, DrainPeriodSecs: 600, Schedule: "07:00",
	})
	if !governed.Reconciled(withExtra) {
		t.Fatal("a matching governed zone should reconcile despite extra controller zones")
	}
}

func TestCropProfileStage(t *testing.T) {
	profile := CropProfile{
		ID: "lettuce", Name: "Lettuce", Crop: "lettuce",
		Stages: []ProfileStage{
			{Stage: "propagation", Targets: sampleSetpoints()},
			{Stage: "vegetative", Targets: sampleSetpoints()},
		},
	}
	if _, ok := profile.Stage("vegetative"); !ok {
		t.Fatal("known stage should resolve")
	}
	if _, ok := profile.Stage("fruiting"); ok {
		t.Fatal("unknown stage should not resolve")
	}
}
