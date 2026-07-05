/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base origin for the Go API. Empty (same-origin `/api`) in dev (proxied) and prod (nginx). */
  readonly VITE_API_BASE?: string;
  /**
   * Keycloak OIDC issuer/authority (e.g. `/auth/realms/greenhouse`, same-origin behind the proxy).
   * When unset, auth is disabled: the SPA runs unauthenticated as operator (the 2a posture / dev).
   */
  readonly VITE_OIDC_AUTHORITY?: string;
  /** OIDC public client id registered in the Keycloak realm (e.g. `climate-frontend`). */
  readonly VITE_OIDC_CLIENT_ID?: string;
  /** Redirect URI the Keycloak client returns to (defaults to `<origin>/login/callback`). */
  readonly VITE_OIDC_REDIRECT_URI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
