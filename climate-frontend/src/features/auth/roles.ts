import type { PlatformRole } from "../../hooks/useRole";

/** Keycloak realm role that maps to the platform operator role (platform security §3). */
export const KEYCLOAK_OPERATOR_ROLE = "gh-operator";

/**
 * Decode a JWT access token's payload and return its Keycloak realm roles (`realm_access.roles`).
 * This is an unverified client-side decode purely to drive the UI — the Go API independently
 * verifies the token's signature, so a tampered token buys nothing but a disabled button.
 */
export function parseRoles(accessToken: string | null | undefined): string[] {
  if (!accessToken) return [];
  const segments = accessToken.split(".");
  if (segments.length < 2) return [];
  try {
    const json = decodeBase64Url(segments[1]);
    const payload = JSON.parse(json) as { realm_access?: { roles?: unknown } };
    const roles = payload.realm_access?.roles;
    return Array.isArray(roles)
      ? roles.filter((role): role is string => typeof role === "string")
      : [];
  } catch {
    return [];
  }
}

/** Map Keycloak realm roles onto the platform role: operator iff the operator role is present. */
export function deriveRole(roles: string[]): PlatformRole {
  return roles.includes(KEYCLOAK_OPERATOR_ROLE) ? "operator" : "viewer";
}

function decodeBase64Url(input: string): string {
  const base64 = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
