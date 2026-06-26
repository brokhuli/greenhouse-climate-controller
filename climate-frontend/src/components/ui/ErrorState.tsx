import { RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "./Button";

/**
 * The canonical error rendering (interactions §9): the cause plus a Retry. Cached data stays
 * visible underneath where possible — degrade, don't blank.
 */
export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="border-border bg-surface-1 flex flex-col items-start gap-3 rounded-lg border p-5"
    >
      <div className="flex items-center gap-2">
        <TriangleAlert size={16} aria-hidden style={{ color: "var(--color-fault)" }} />
        <p className="text-fg-default text-base font-medium">{title}</p>
      </div>
      {message ? <p className="text-fg-muted text-sm">{message}</p> : null}
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          <RotateCw size={14} aria-hidden />
          Retry
        </Button>
      ) : null}
    </div>
  );
}
