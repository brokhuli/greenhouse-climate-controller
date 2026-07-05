package config

import "testing"

func TestLoadDefaultsServiceAuthModeToTrustedNetwork(t *testing.T) {
	t.Setenv("PLATFORM_DATABASE_URL", "postgres://x")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ServiceAuthMode != ServiceAuthModeTrustedNetwork {
		t.Fatalf("default ServiceAuthMode = %q, want %q", cfg.ServiceAuthMode, ServiceAuthModeTrustedNetwork)
	}
}

func TestLoadOIDCServiceAuthModeRequiresIssuer(t *testing.T) {
	t.Setenv("PLATFORM_DATABASE_URL", "postgres://x")
	t.Setenv("PLATFORM_SERVICE_AUTH_MODE", ServiceAuthModeOIDC)

	if _, err := Load(); err == nil {
		t.Fatal("expected error: oidc service-auth mode without an OIDC issuer")
	}

	t.Setenv("PLATFORM_OIDC_ISSUER_URL", "http://localhost:8080/auth/realms/greenhouse")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load with issuer set: %v", err)
	}
	if cfg.ServiceAuthMode != ServiceAuthModeOIDC {
		t.Fatalf("ServiceAuthMode = %q, want %q", cfg.ServiceAuthMode, ServiceAuthModeOIDC)
	}
}

func TestLoadRejectsUnknownServiceAuthMode(t *testing.T) {
	t.Setenv("PLATFORM_DATABASE_URL", "postgres://x")
	t.Setenv("PLATFORM_SERVICE_AUTH_MODE", "bogus")

	if _, err := Load(); err == nil {
		t.Fatal("expected error for unknown PLATFORM_SERVICE_AUTH_MODE")
	}
}
