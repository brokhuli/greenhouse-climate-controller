package api

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/reconcile"
)

func (s *Server) getAssignment(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")
	exists, err := s.store.Exists(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	if !exists {
		return respondNotFound(c, "greenhouse not found")
	}
	assignment, found, err := s.store.GetAssignment(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	if !found {
		return respondNotFound(c, "no assignment for greenhouse")
	}
	return c.JSON(http.StatusOK, assignment)
}

// setAssignment assigns a profile/stage to a greenhouse and applies it: the stage's targets are
// resolved and pushed to the controller through the reconciler (recorded as intended state,
// re-asserted on reconnect). An unknown profile or a stage not in that profile is a 422.
func (s *Server) setAssignment(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")
	var input assignmentInputDTO
	if ok, err := s.decodeBody(c, &input); !ok {
		return err
	}
	if verr := validateAssignmentInput(input); verr != nil {
		return respondValidation(c, verr)
	}
	exists, err := s.store.Exists(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	if !exists {
		return respondNotFound(c, "greenhouse not found")
	}
	profile, found, err := s.store.GetProfile(ctx, input.ProfileID)
	if err != nil {
		return s.fail(c, err)
	}
	if !found {
		return respondValidation(c, &valError{Field: "profile_id", Bound: "existing profile", Value: input.ProfileID})
	}
	stage, ok := profile.Stage(input.Stage)
	if !ok {
		return respondValidation(c, &valError{Field: "stage", Bound: "a stage of the profile", Value: input.Stage})
	}

	assignment := domain.Assignment{GreenhouseID: id, ProfileID: input.ProfileID, Stage: input.Stage}
	if err := s.store.SetAssignment(ctx, assignment); err != nil {
		return s.fail(c, err)
	}
	reason := fmt.Sprintf("profile %s stage %s", input.ProfileID, input.Stage)
	outcome, err := s.reconcile.Apply(ctx, id, stage.Targets, domain.SourceProfile, "operator", reason)
	if err != nil {
		if errors.Is(err, reconcile.ErrUnknownGreenhouse) {
			return respondNotFound(c, "greenhouse not found")
		}
		return s.fail(c, err)
	}
	// A controller validation refusal (rare — profile targets were validated on creation) is
	// surfaced verbatim rather than masked as a successful assignment.
	if outcome.ControllerStatus != 0 && !outcome.Delivered && !outcome.Deferred {
		return c.JSONBlob(outcome.ControllerStatus, outcome.ControllerBody)
	}
	s.log.Info("profile assigned", "id", id, "profile", input.ProfileID, "stage", input.Stage, "delivered", outcome.Delivered)
	return c.JSON(http.StatusOK, assignment)
}
