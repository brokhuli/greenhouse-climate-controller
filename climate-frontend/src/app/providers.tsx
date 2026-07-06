import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { ThemeProvider } from "../hooks/ThemeProvider";
import { ToastProvider } from "../components/ui/ToastProvider";
import { AuthProvider } from "../features/auth/AuthProvider";
import { shouldRetryQuery, queryRetryDelay } from "../api/retryPolicy";
import { StreamProvider } from "./StreamProvider";

/**
 * App-wide providers: server-state cache (TanStack Query), theming, the toast queue, auth/session,
 * the single live stream (which patches the cache and raises toasts), and the router.
 * `AuthProvider` sits above `StreamProvider` because the live socket authenticates with the access
 * token; when OIDC is unconfigured it is a pass-through (the 2a unauthenticated posture).
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            // Retry only transient network failures (once), never server overload/dependency errors,
            // and don't re-fire every query on tab focus — so the browser backs off instead of
            // amplifying load when the platform is struggling.
            retry: shouldRetryQuery,
            retryDelay: queryRetryDelay,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <StreamProvider>
              <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                {children}
              </BrowserRouter>
            </StreamProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
