import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { ThemeProvider } from "../hooks/ThemeProvider";
import { ToastProvider } from "../components/ui/ToastProvider";
import { StreamProvider } from "./StreamProvider";

/**
 * App-wide providers: server-state cache (TanStack Query), theming, the toast queue, the single
 * live stream (which patches the cache and raises toasts), and the router. `StreamProvider` sits
 * under the query and toast providers because it depends on both.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            retry: 2,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <StreamProvider>
            <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
              {children}
            </BrowserRouter>
          </StreamProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
