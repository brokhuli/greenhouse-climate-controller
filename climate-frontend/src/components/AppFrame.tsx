import type { ReactNode } from "react";
import { SideNav } from "./SideNav";
import { TopBar } from "./TopBar";

/**
 * Root layout — the operations-console shell that survives any view-level error or network
 * failure (architecture §9): a fixed SideNav, a TopBar, and a scrolling main canvas.
 */
export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full">
      <a
        href="#main-content"
        className="focus:bg-surface-raised sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[var(--z-toast)] focus:rounded-md focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <SideNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main
          id="main-content"
          className="min-h-0 flex-1 overflow-auto"
          style={{ padding: "var(--layout-gutter)" }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
