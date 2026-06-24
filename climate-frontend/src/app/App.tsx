import { Suspense } from "react";
import { AppFrame } from "../components/AppFrame";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { AppRoutes } from "./routes";

/** Root: the persistent console shell wrapping the routed views, guarded by an error boundary. */
export function App() {
  return (
    <AppFrame>
      <ErrorBoundary>
        <Suspense fallback={<div className="text-fg-muted text-sm">Loading…</div>}>
          <AppRoutes />
        </Suspense>
      </ErrorBoundary>
    </AppFrame>
  );
}
