package api

import (
	"net/http"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
)

func (s *Server) listEvents(c echo.Context) error {
	ctx := c.Request().Context()
	var filter store.EventFilter
	if greenhouseID := c.QueryParam("greenhouse_id"); greenhouseID != "" {
		filter.GreenhouseID = &greenhouseID
	}
	// Unknown filter values are ignored rather than rejected — the activity feed only
	// defines a 200 response (frontend-rest events).
	if kind := c.QueryParam("kind"); domain.EventKinds[kind] {
		filter.Kind = &kind
	}
	if severity := c.QueryParam("severity"); domain.EventSeverities[severity] {
		filter.MinSeverity = &severity
	}
	events, err := s.store.ListEvents(ctx, filter)
	if err != nil {
		return s.fail(c, err)
	}
	entries := make([]eventEntryDTO, 0, len(events))
	for _, event := range events {
		entries = append(entries, eventEntryDTO{
			GreenhouseID: event.GreenhouseID,
			TS:           fmtTS(event.TS),
			Kind:         event.Kind,
			Severity:     event.Severity,
			Message:      event.Message,
			Source:       event.Source,
		})
	}
	return c.JSON(http.StatusOK, entries)
}
