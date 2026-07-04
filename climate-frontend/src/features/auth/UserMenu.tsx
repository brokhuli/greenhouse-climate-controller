import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useRole } from "../../hooks/useRole";
import { Button } from "../../components/ui/Button";

/**
 * Identity affordance in the top bar: who is signed in, their capability role, and sign-out. Renders
 * nothing when auth is disabled (dev / the 2a posture), and a Sign-in button when configured but not
 * yet authenticated.
 */
export function UserMenu() {
  const { authEnabled, isAuthenticated, username, role, signIn, signOut } = useRole();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!authEnabled) return null;

  if (!isAuthenticated) {
    return (
      <Button variant="secondary" onClick={signIn}>
        Sign in
      </Button>
    );
  }

  const displayName = username ?? "user";
  const roleLabel = role === "operator" ? "Operator" : "Viewer";
  const initials = displayName
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  const handleSignOut = () => {
    setOpen(false);
    signOut();
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Signed in as ${displayName}, ${roleLabel}. Open user menu`}
        className="hover:bg-surface-3 focus:border-accent flex min-w-0 items-center gap-3 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors duration-[var(--motion-instant)] outline-none"
      >
        <span
          aria-hidden
          className="border-border-strong bg-surface-3 text-fg-default flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold shadow-[inset_0_0_0_1px_var(--color-surface-1)]"
        >
          {initials || "U"}
        </span>
        <span className="min-w-0 pr-1 leading-tight">
          <span className="text-fg-default block max-w-36 truncate text-sm font-semibold">
            {displayName}
          </span>
          <span className="text-fg-muted block max-w-36 truncate text-sm">{roleLabel}</span>
        </span>
        <ChevronDown
          className={`text-fg-muted shrink-0 transition-transform duration-[var(--motion-instant)] ${
            open ? "rotate-180" : ""
          }`}
          size={18}
          aria-hidden
        />
      </button>

      {open ? (
        <div
          role="menu"
          className="border-border bg-surface-raised absolute top-full right-0 z-[var(--z-popover)] mt-2 min-w-40 rounded-md border p-1 shadow-[var(--shadow-md)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            className="text-fg-default hover:bg-surface-3 focus:bg-surface-3 flex w-full items-center rounded px-3 py-2 text-left text-sm outline-none"
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
