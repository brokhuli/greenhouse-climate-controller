import { useEffect, type ReactNode } from "react";
import { AuthProvider as OidcProvider, useAuth, type AuthProviderProps } from "react-oidc-context";
import { WebStorageStateStore } from "oidc-client-ts";
import { RoleContext, type AuthState } from "../../hooks/useRole";
import { setAccessToken, setUnauthorizedHandler } from "../../api/authToken";
import { deriveRole, parseRoles } from "./roles";

const AUTHORITY = import.meta.env.VITE_OIDC_AUTHORITY;
const CLIENT_ID = import.meta.env.VITE_OIDC_CLIENT_ID;

/** Client-side route Keycloak redirects back to after login (owned by the SPA, not `/auth`). */
export const CALLBACK_PATH = "/login/callback";

/**
 * Top-level auth boundary. When OIDC is configured it wraps `react-oidc-context` and maps its state
 * into the app's `RoleContext`; when it is not (dev / tests / the 2a posture) it renders children
 * directly, leaving the open-operator default in place. Nothing else in the app imports
 * `react-oidc-context` (frontend architecture §2, boundary 1).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  if (!AUTHORITY || !CLIENT_ID) {
    return <>{children}</>;
  }

  const config: AuthProviderProps = {
    authority: AUTHORITY,
    client_id: CLIENT_ID,
    redirect_uri:
      import.meta.env.VITE_OIDC_REDIRECT_URI ?? `${window.location.origin}${CALLBACK_PATH}`,
    post_logout_redirect_uri: window.location.origin,
    response_type: "code",
    scope: "openid profile email",
    automaticSilentRenew: true,
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    onSigninCallback: () => {
      // Drop the ?code&state from the URL so a refresh doesn't reprocess the response.
      window.history.replaceState({}, document.title, window.location.pathname);
    },
  };

  return (
    <OidcProvider {...config}>
      <RoleBridge>{children}</RoleBridge>
    </OidcProvider>
  );
}

/** Maps `react-oidc-context` state into `RoleContext` and syncs the token holder. Anonymous
 *  visitors are let through as read-only viewers — login is only needed to gain the operator
 *  (write) role — so nothing forces a redirect to Keycloak on first access. */
function RoleBridge({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? null;

  useEffect(() => {
    setAccessToken(accessToken);
  }, [accessToken]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Only bounce a signed-in user whose token expired; never yank an anonymous viewer
      // (who holds no token) into the login flow over a stray 401.
      if (!accessToken) return;
      void auth.signinRedirect({
        state: { returnTo: window.location.pathname + window.location.search },
      });
    });
    return () => setUnauthorizedHandler(null);
  }, [auth, accessToken]);

  const role = deriveRole(parseRoles(accessToken));
  const value: AuthState = {
    authEnabled: true,
    isAuthenticated: auth.isAuthenticated,
    isLoading: auth.isLoading,
    role,
    isOperator: role === "operator",
    username:
      (auth.user?.profile.preferred_username as string | undefined) ??
      auth.user?.profile.name ??
      null,
    signIn: () => void auth.signinRedirect(),
    signOut: () => void auth.signoutRedirect(),
  };

  // No auth gate: render the app for anonymous viewers and signed-in users alike. The
  // `/login/callback` route renders its own splash while the code exchange completes.
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}
