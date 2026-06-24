import { ConnectionStatus } from "./ConnectionStatus";
import { ThemeToggle } from "./ThemeToggle";

/** Header strip: current scope, live connection status, and the theme toggle (components §1). */
export function TopBar() {
  return (
    <header
      className="border-border bg-surface-1 flex shrink-0 items-center justify-between border-b px-6"
      style={{ height: "var(--layout-topbar-height)" }}
    >
      <div>
        <h1 className="text-fg-default text-lg font-semibold">Greenhouse Site</h1>
        <p className="text-fg-muted text-sm">Fleet operations console</p>
      </div>
      <div className="flex items-center gap-3">
        {/* Wired to the live socket state once ws.ts is mounted in a feature slice. */}
        <ConnectionStatus state="offline" />
        <ThemeToggle />
      </div>
    </header>
  );
}
