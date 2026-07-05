package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/labstack/echo/v4"

	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/domain"
	"github.com/brokhuli/greenhouse-climate-controller/climate-platform/internal/store"
)

func (s *Server) listProfiles(c echo.Context) error {
	profiles, err := s.store.ListProfiles(c.Request().Context())
	if err != nil {
		return s.fail(c, err)
	}
	if profiles == nil {
		profiles = []domain.CropProfile{}
	}
	return c.JSON(http.StatusOK, profiles)
}

func (s *Server) createProfile(c echo.Context) error {
	ctx := c.Request().Context()
	var profile domain.CropProfile
	if ok, err := s.decodeBody(c, &profile); !ok {
		return err
	}
	if verr := validateProfile(profile); verr != nil {
		return respondValidation(c, verr)
	}
	if err := s.store.CreateProfile(ctx, profile); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return respondValidation(c, &valError{Field: "id", Bound: "unique", Value: profile.ID, Msg: "profile already exists"})
		}
		return s.fail(c, err)
	}
	s.log.Info("crop profile created", "id", profile.ID)
	return c.JSON(http.StatusCreated, profile)
}

func (s *Server) getProfile(c echo.Context) error {
	profile, found, err := s.store.GetProfile(c.Request().Context(), c.Param("profileID"))
	if err != nil {
		return s.fail(c, err)
	}
	if !found {
		return respondNotFound(c, "profile not found")
	}
	return c.JSON(http.StatusOK, profile)
}

func (s *Server) updateProfile(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("profileID")
	var patch cropProfilePatchDTO
	if ok, err := s.decodeBody(c, &patch); !ok {
		return err
	}
	if verr := validateProfilePatch(patch); verr != nil {
		return respondValidation(c, verr)
	}
	profile, found, err := s.store.GetProfile(ctx, id)
	if err != nil {
		return s.fail(c, err)
	}
	if !found {
		return respondNotFound(c, "profile not found")
	}
	if patch.Name != nil {
		profile.Name = *patch.Name
	}
	if patch.Crop != nil {
		profile.Crop = *patch.Crop
	}
	if patch.Stages != nil {
		profile.Stages = patch.Stages
	}
	if _, err := s.store.UpdateProfile(ctx, profile); err != nil {
		return s.fail(c, err)
	}
	s.log.Info("crop profile updated", "id", id)
	return c.JSON(http.StatusOK, profile)
}

func (s *Server) deleteProfile(c echo.Context) error {
	id := c.Param("profileID")
	found, err := s.store.DeleteProfile(c.Request().Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrProfileInUse) {
			return respondValidation(c, &valError{Field: "id", Bound: "not in use", Value: id, Msg: "profile is assigned to a greenhouse"})
		}
		return s.fail(c, err)
	}
	if !found {
		return respondNotFound(c, "profile not found")
	}
	s.log.Info("crop profile deleted", "id", id)
	return c.NoContent(http.StatusNoContent)
}

// decodeBody strictly decodes a JSON request body into dst, rejecting unknown fields to honor
// the contracts' additionalProperties:false. It writes the error response itself; ok is false
// when the caller should return the accompanying error.
func (s *Server) decodeBody(c echo.Context, dst any) (ok bool, err error) {
	dec := json.NewDecoder(c.Request().Body)
	dec.DisallowUnknownFields()
	if decErr := dec.Decode(dst); decErr != nil {
		if field, isUnknown := unknownFieldName(decErr); isUnknown {
			return false, respondValidation(c, &valError{Field: field, Bound: "unknown field not permitted"})
		}
		return false, respondError(c, http.StatusBadRequest, "invalid JSON body")
	}
	return true, nil
}
