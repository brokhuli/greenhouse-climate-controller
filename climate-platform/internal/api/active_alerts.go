package api

import (
	"net/http"
	"sort"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
)

// listActiveAlerts serves the current retained controller fault set, using the activity feed's
// greenhouse/kind/minimum-severity filter semantics.
func (s *Server) listActiveAlerts(c echo.Context) error {
	greenhouses, err := s.store.ListGreenhouses(c.Request().Context())
	if err != nil {
		return s.fail(c, err)
	}
	greenhouseID, kind, minimum := c.QueryParam("greenhouse_id"), c.QueryParam("kind"), c.QueryParam("severity")
	if !domain.EventKinds[kind] {
		kind = ""
	}
	if !domain.EventSeverities[minimum] {
		minimum = ""
	}
	alerts := make([]activeAlertDTO, 0)
	for _, greenhouse := range greenhouses {
		if greenhouseID != "" && greenhouse.ID != greenhouseID {
			continue
		}
		snapshot, found := s.fleet.Snapshot(greenhouse.ID)
		if !found {
			continue
		}
		for key, fault := range snapshot.ActiveFaults {
			alertKind := "fault"
			if domain.InterlockFaults[fault.FaultType] {
				alertKind = "interlock"
			}
			severity := "warning"
			if fault.Severity == "alarm" {
				severity = "critical"
			}
			if kind != "" && alertKind != kind {
				continue
			}
			if !meetsMinimumSeverity(severity, minimum) {
				continue
			}
			var zoneID *string
			if key.ZoneID != "" {
				zone := key.ZoneID
				zoneID = &zone
			}
			alerts = append(alerts, activeAlertDTO{GreenhouseID: greenhouse.ID, Component: key.Component, ZoneID: zoneID, FaultType: fault.FaultType, Kind: alertKind, Severity: severity, Since: fmtTS(fault.Since)})
		}
	}
	sort.Slice(alerts, func(i, j int) bool { return alerts[i].Since < alerts[j].Since })
	return c.JSON(http.StatusOK, alerts)
}

func meetsMinimumSeverity(severity, minimum string) bool {
	levels := map[string]int{"info": 0, "warning": 1, "critical": 2}
	return minimum == "" || levels[severity] >= levels[minimum]
}
