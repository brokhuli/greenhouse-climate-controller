/**
 * Module-level holder for the current OIDC access token.
 *
 * `client.ts` (the REST fetch wrapper) and `ws.ts` (the live socket) are plain modules, not React
 * components, so they cannot read the AuthProvider context directly. The auth layer pushes the
 * current token here whenever it changes (login, silent renew, logout); the transports read it when
 * they build a request. When auth is disabled the token stays null and both transports behave as in
 * 2a (no Authorization header, no `access_token` query param).
 */

let accessToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

/** Called by the auth layer whenever the access token changes (null on logout / disabled). */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** The current access token, or null when unauthenticated. */
export function getAccessToken(): string | null {
  return accessToken;
}

/**
 * Register what to do when the API rejects a request with 401 (token expired past the silent
 * renew, or revoked). The auth layer wires this to a login redirect; unset (auth disabled) is a
 * no-op so the 2a posture is unaffected.
 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/** Invoked by the REST client on a 401 response. */
export function handleUnauthorized(): void {
  unauthorizedHandler?.();
}
