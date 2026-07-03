import { LogOut, ShieldCheck, UserRound } from "lucide-react";
import { useRole } from "../../hooks/useRole";
import { Button } from "../../components/ui/Button";
import { Pill } from "../../components/ui/Pill";

/**
 * Identity affordance in the top bar: who is signed in, their capability role, and sign-out. Renders
 * nothing when auth is disabled (dev / the 2a posture), and a Sign-in button when configured but not
 * yet authenticated.
 */
export function UserMenu() {
  const { authEnabled, isAuthenticated, username, role, signIn, signOut } = useRole();

  if (!authEnabled) return null;

  if (!isAuthenticated) {
    return (
      <Button variant="secondary" onClick={signIn}>
        Sign in
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-fg-muted flex items-center gap-1.5 text-sm">
        <UserRound size={16} aria-hidden />
        <span className="text-fg-default font-medium">{username ?? "user"}</span>
      </span>
      <Pill icon={role === "operator" ? <ShieldCheck size={12} aria-hidden /> : undefined}>
        {role}
      </Pill>
      <Button variant="ghost" onClick={signOut} title="Sign out" aria-label="Sign out">
        <LogOut size={16} aria-hidden />
      </Button>
    </div>
  );
}
