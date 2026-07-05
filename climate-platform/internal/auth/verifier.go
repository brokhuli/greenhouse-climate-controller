package auth

import (
	"context"
	"fmt"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// Verifier validates bearer tokens against Keycloak's published JWKS (signature, issuer,
// audience, expiry) and extracts the platform claims. A nil *Verifier means auth is
// disabled — the API runs unauthenticated, as in 2a. The verification itself is held in a
// func so tests can substitute a fake without minting real JWTs.
type Verifier struct {
	verify func(ctx context.Context, rawToken string) (*Claims, error)
}

// NewVerifier performs OIDC discovery and builds a token verifier. When issuerURL is empty
// it returns (nil, nil): OIDC is not configured, so the caller runs open (the 2a
// trusted-network posture). Discovery is retried with backoff because Keycloak may still be
// importing its realm when the API starts.
//
// discoveryURL lets the API reach Keycloak on the internal Docker network
// (e.g. http://auth:8080/...) while the tokens' issuer claim uses the browser-facing public
// URL (e.g. http://localhost:8080/auth/...): when the two differ, discovery trusts the
// public issuer via oidc.InsecureIssuerURLContext. audience, when set, is required in the
// token's `aud`; when empty the audience check is skipped.
func NewVerifier(ctx context.Context, issuerURL, discoveryURL, audience string) (*Verifier, error) {
	if issuerURL == "" {
		return nil, nil
	}
	if discoveryURL == "" {
		discoveryURL = issuerURL
	}

	discoveryCtx := ctx
	if discoveryURL != issuerURL {
		// The discovery document reports the public issuer, which will not match the
		// internal URL we fetch it from; trust it explicitly.
		discoveryCtx = oidc.InsecureIssuerURLContext(ctx, issuerURL)
	}

	provider, err := discoverWithRetry(discoveryCtx, discoveryURL)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery (%s): %w", discoveryURL, err)
	}

	oidcVerifier := provider.Verifier(&oidc.Config{
		ClientID:          audience,
		SkipClientIDCheck: audience == "",
	})

	return &Verifier{verify: func(ctx context.Context, rawToken string) (*Claims, error) {
		token, err := oidcVerifier.Verify(ctx, rawToken)
		if err != nil {
			return nil, err
		}
		var claimSet struct {
			Subject           string `json:"sub"`
			PreferredUsername string `json:"preferred_username"`
			RealmAccess       struct {
				Roles []string `json:"roles"`
			} `json:"realm_access"`
		}
		if err := token.Claims(&claimSet); err != nil {
			return nil, fmt.Errorf("decode token claims: %w", err)
		}
		return &Claims{
			Subject:  claimSet.Subject,
			Username: claimSet.PreferredUsername,
			Roles:    claimSet.RealmAccess.Roles,
		}, nil
	}}, nil
}

// Verify validates a raw bearer token and returns its platform claims.
func (v *Verifier) Verify(ctx context.Context, rawToken string) (*Claims, error) {
	return v.verify(ctx, rawToken)
}

// discoverWithRetry runs OIDC discovery, retrying a slow-to-start Keycloak so a realm import
// in progress does not fail API boot outright. Runs a linear backoff up to about 60 seconds 
// before failing.
func discoverWithRetry(ctx context.Context, discoveryURL string) (*oidc.Provider, error) {
	const (
		attempts = 10
		waitStep = time.Second
	)
	var lastErr error
	for i := 0; i < attempts; i++ {
		provider, err := oidc.NewProvider(ctx, discoveryURL)
		if err == nil {
			return provider, nil
		}
		lastErr = err
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(i+1) * waitStep):
		}
	}
	return nil, lastErr
}
