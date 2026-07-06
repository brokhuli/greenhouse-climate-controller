import { ApiError } from "./client";

/**
 * The default query retry/backoff policy for the SPA. Kept separate from the fetch client so the
 * decision is a pure, unit-testable function of `(failureCount, error)` (architecture: separate
 * domain logic from infrastructure). Applied globally in `providers.tsx`.
 */

/**
 * Retry only a request that never completed (a transient network failure), and only once.
 * 429/503/5xx are backpressure/overload — retrying them amplifies the load the server is already
 * shedding; 404/422/parse are deterministic and a retry cannot fix them.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  return error instanceof ApiError && error.kind === "network";
}

/** Exponential backoff with jitter, bounded at 30s — used for the single network retry. */
export function queryRetryDelay(attemptIndex: number): number {
  return Math.min(1000 * 2 ** attemptIndex, 30_000) + Math.random() * 250;
}
