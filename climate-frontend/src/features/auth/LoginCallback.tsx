import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth, type AuthContextProps } from "react-oidc-context";
import { AuthSplash } from "./AuthSplash";

/**
 * The OIDC redirect landing (`/login/callback`). `react-oidc-context` (mounted at the app root)
 * exchanges the authorization code automatically; this view just waits, then navigates to where the
 * user started (the `returnTo` stashed in the sign-in state). In auth-disabled mode there is no OIDC
 * provider, so it simply bounces home.
 */
export default function LoginCallback() {
  const auth = useAuth() as AuthContextProps | undefined;
  const navigate = useNavigate();

  useEffect(() => {
    if (!auth) {
      navigate("/", { replace: true });
      return;
    }
    if (auth.isAuthenticated) {
      const returnTo = (auth.user?.state as { returnTo?: string } | undefined)?.returnTo ?? "/";
      navigate(returnTo, { replace: true });
    }
  }, [auth, navigate]);

  return <AuthSplash error={auth?.error?.message} />;
}
