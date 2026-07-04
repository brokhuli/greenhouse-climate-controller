package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
)

// testVerifier maps fixed token strings to roles so the middleware's authorization logic can
// be exercised without minting real JWTs (the go-oidc glue is covered by the live E2E).
func testVerifier() *Verifier {
	return &Verifier{verify: func(_ context.Context, raw string) (*Claims, error) {
		switch raw {
		case "operator-token":
			return &Claims{Subject: "u1", Username: "op", Roles: []string{KeycloakOperatorRole}}, nil
		case "viewer-token":
			return &Claims{Subject: "u2", Username: "vw", Roles: []string{KeycloakViewerRole}}, nil
		default:
			return nil, errors.New("invalid token")
		}
	}}
}

func TestAuthMiddleware(t *testing.T) {
	cases := []struct {
		name         string
		verifier     *Verifier
		operatorOnly bool
		authHeader   string
		queryToken   string
		wantStatus   int
	}{
		{"disabled read passes through", nil, false, "", "", http.StatusOK},
		{"disabled write passes through", nil, true, "", "", http.StatusOK},
		{"enabled anonymous read 200", testVerifier(), false, "", "", http.StatusOK},
		{"enabled anonymous write 401", testVerifier(), true, "", "", http.StatusUnauthorized},
		{"enabled invalid token read 401", testVerifier(), false, "Bearer nope", "", http.StatusUnauthorized},
		{"enabled viewer read 200", testVerifier(), false, "Bearer viewer-token", "", http.StatusOK},
		{"enabled viewer write 403", testVerifier(), true, "Bearer viewer-token", "", http.StatusForbidden},
		{"enabled operator write 200", testVerifier(), true, "Bearer operator-token", "", http.StatusOK},
		{"ws query-param token 200", testVerifier(), false, "", "operator-token", http.StatusOK},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			router := echo.New()
			group := router.Group("/api")
			group.Use(OptionalAuth(tc.verifier))
			handler := func(c echo.Context) error { return c.NoContent(http.StatusOK) }
			if tc.operatorOnly {
				group.GET("/x", handler, RequireOperator(tc.verifier))
			} else {
				group.GET("/x", handler)
			}

			target := "/api/x"
			if tc.queryToken != "" {
				target += "?access_token=" + tc.queryToken
			}
			req := httptest.NewRequest(http.MethodGet, target, nil)
			if tc.authHeader != "" {
				req.Header.Set("Authorization", tc.authHeader)
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
		})
	}
}

// TestClaimsReachHandler confirms OptionalAuth stashes claims for handlers (the audit trail).
func TestClaimsReachHandler(t *testing.T) {
	router := echo.New()
	group := router.Group("/api")
	group.Use(OptionalAuth(testVerifier()))
	group.GET("/whoami", func(c echo.Context) error {
		claims := ClaimsFrom(c)
		if claims == nil {
			return c.String(http.StatusInternalServerError, "no claims")
		}
		return c.String(http.StatusOK, claims.Username)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/whoami", nil)
	req.Header.Set("Authorization", "Bearer operator-token")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || rec.Body.String() != "op" {
		t.Fatalf("got %d %q, want 200 \"op\"", rec.Code, rec.Body.String())
	}
}
