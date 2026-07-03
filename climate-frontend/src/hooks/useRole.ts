import { createContext, useContext } from "react";

/** The platform's two capability roles (platform security §3). */
export type PlatformRole = "viewer" | "operator";

/**
 * The session/auth state the UI reads. Everything outside `features/auth/` depends only on this —
 * never on `react-oidc-context` directly — so swapping the identity layer touches one folder
 * (frontend architecture §5, session state).
 */
export type AuthState = {
  /**
   * Whether OIDC is configured. False in dev/test (no `VITE_OIDC_AUTHORITY`): the console runs
   * unauthenticated and everyone is treated as an operator — the 2a trusted-network posture.
   */
  authEnabled: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
  role: PlatformRole;
  /** Convenience: role === "operator". Every write affordance gates on this. */
  isOperator: boolean;
  username: string | null;
  signIn: () => void;
  signOut: () => void;
};

/** Default: auth disabled, operator — so components render open without an AuthProvider (tests). */
const OPEN_OPERATOR: AuthState = {
  authEnabled: false,
  isAuthenticated: true,
  isLoading: false,
  role: "operator",
  isOperator: true,
  username: null,
  signIn: () => {},
  signOut: () => {},
};

export const RoleContext = createContext<AuthState>(OPEN_OPERATOR);

/** Read the current session role/state. Write controls disable when `!isOperator`. */
export function useRole(): AuthState {
  return useContext(RoleContext);
}
