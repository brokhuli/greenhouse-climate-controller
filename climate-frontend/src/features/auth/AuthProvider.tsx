import { useEffect, type ReactNode } from "react";
import { AuthProvider as OidcProvider, useAuth, type AuthProviderProps } from "react-oidc-context";
import { WebStorageStateStore } from "oidc-client-ts";
import { RoleContext, type AuthState } from "../../hooks/useRole";
import { setAccessToken, setUnauthorizedHandler } from "../../api/authToken";
import { deriveRole, parseRoles } from "./roles";
import { AuthSplash } from "./AuthSplash";

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

/** Maps `react-oidc-context` state into `RoleContext`, syncs the token holder, and auto-redirects an
 *  unauthenticated visitor to Keycloak (except while the callback is being processed). */
function RoleBridge({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const accessToken = auth.user?.access_token ?? null;
  const onCallback = window.location.pathname === CALLBACK_PATH;

  useEffect(() => {
    setAccessToken(accessToken);
  }, [accessToken]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void auth.signinRedirect({
        state: { returnTo: window.location.pathname + window.location.search },
      });
    });
    return () => setUnauthorizedHandler(null);
  }, [auth]);

  useEffect(() => {
    if (onCallback) return;
    if (!auth.isAuthenticated && !auth.isLoading && !auth.activeNavigator && !auth.error) {
      void auth.signinRedirect({
        state: { returnTo: window.location.pathname + window.location.search },
      });
    }
  }, [auth, onCallback]);

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

  // Hold the app behind a splash until authenticated; the callback route renders its own splash.
  if (!onCallback && !auth.isAuthenticated) {
    return (
      <RoleContext.Provider value={value}>
        <AuthSplash error={auth.error?.message} />
      </RoleContext.Provider>
    );
  }

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}
