package api

import (
	"testing"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

func zoneDTO(id string, low, high float64, drain int, schedule string) zoneTargetsDTO {
	return zoneTargetsDTO{
		ZoneID:                sptr(id),
		MoistureLowThreshold:  fptr(low),
		MoistureHighThreshold: fptr(high),
		DrainPeriodSecs:       iptr(drain),
		Schedule:              sptr(schedule),
	}
}

// twoZoneBaseline is fullSetpoints (bench-a) plus a second zone, for exercising the by-id merge.
func twoZoneBaseline() domain.Setpoints {
	base := fullSetpoints()
	base.Zones = append(base.Zones, domain.ZoneTargets{
		ZoneID: "bench-b", MoistureLowThreshold: 0.25, MoistureHighThreshold: 0.5, DrainPeriodSecs: 400, Schedule: "05:00",
	})
	return base
}

func TestApplyPatchMergesZonesByID(t *testing.T) {
	base := twoZoneBaseline()
	patch := setpointsPatchDTO{Zones: []zoneTargetsDTO{zoneDTO("bench-a", 0.35, 0.55, 300, "07:00")}}

	got, verr := applyPatch(base, patch)
	if verr != nil {
		t.Fatalf("valid zone patch rejected: %+v", verr)
	}
	// The named zone is replaced with the patch's targets...
	if a := got.Zones[0]; a.ZoneID != "bench-a" || a.MoistureLowThreshold != 0.35 ||
		a.MoistureHighThreshold != 0.55 || a.DrainPeriodSecs != 300 || a.Schedule != "07:00" {
		t.Fatalf("bench-a not updated: %+v", a)
	}
	// ...and a zone the patch does not name is carried through unchanged.
	if b := got.Zones[1]; b.ZoneID != "bench-b" || b.MoistureLowThreshold != 0.25 || b.Schedule != "05:00" {
		t.Fatalf("bench-b should be unchanged: %+v", b)
	}
}

func TestApplyPatchDoesNotMutateBaseline(t *testing.T) {
	base := fullSetpoints()
	patch := setpointsPatchDTO{Zones: []zoneTargetsDTO{zoneDTO("bench-a", 0.35, 0.55, 300, "07:00")}}
	if _, verr := applyPatch(base, patch); verr != nil {
		t.Fatalf("unexpected rejection: %+v", verr)
	}
	if base.Zones[0].MoistureLowThreshold != 0.3 {
		t.Fatalf("baseline zone was mutated in place: %+v", base.Zones[0])
	}
}

func TestApplyPatchRejectsZones(t *testing.T) {
	cases := map[string]struct {
		zones []zoneTargetsDTO
		field string
	}{
		"unknown zone_id": {
			[]zoneTargetsDTO{zoneDTO("bench-z", 0.35, 0.55, 300, "07:00")}, "zones[0].zone_id",
		},
		"duplicate zone_id": {
			[]zoneTargetsDTO{
				zoneDTO("bench-a", 0.35, 0.55, 300, "07:00"),
				zoneDTO("bench-a", 0.36, 0.56, 310, "08:00"),
			}, "zones[1].zone_id",
		},
		"incomplete zone (missing schedule)": {
			[]zoneTargetsDTO{{
				ZoneID: sptr("bench-a"), MoistureLowThreshold: fptr(0.35),
				MoistureHighThreshold: fptr(0.55), DrainPeriodSecs: iptr(300),
			}}, "zones[0].schedule",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, verr := applyPatch(fullSetpoints(), setpointsPatchDTO{Zones: tc.zones})
			if verr == nil {
				t.Fatalf("%s: expected a validation error", name)
			}
			if verr.Field != tc.field {
				t.Fatalf("%s: field = %q, want %q", name, verr.Field, tc.field)
			}
		})
	}
}
