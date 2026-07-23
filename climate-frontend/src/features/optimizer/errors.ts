import { ApiError, getHttpStatus } from "../../api/client";

/**
 * Map a failed optimizer mutation to an operator-facing message. The write endpoints share a few
 * meaningful statuses: `409` (the optimizer is paused or already planning that greenhouse), `400`
 * (a model outside the allowlist), and the synthesized `unavailable` when the optimizer can't be
 * reached at all. Everything else falls back to the API's own message, then the caller's default.
 */
export function optimizerActionError(error: unknown, fallback: string): string {
  const status = getHttpStatus(error);
  if (status === 409) return "The optimizer is paused or already planning this greenhouse.";
  if (status === 400) return "That model isn't in the current provider's allowlist.";
  if (error instanceof ApiError && error.kind === "unavailable") {
    return "The optimizer is unavailable right now.";
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
