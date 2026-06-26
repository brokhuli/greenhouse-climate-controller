import type { ReactNode } from "react";

/**
 * The canonical empty rendering (interactions §9): a one-line explanation plus the relevant action
 * (e.g. "No greenhouses registered" → Register).
 */
export function EmptyState({
  title,
  message,
  action,
  icon,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="border-border flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
      {icon ? <div className="text-fg-subtle">{icon}</div> : null}
      <div>
        <p className="text-fg-default text-base font-medium">{title}</p>
        {message ? <p className="text-fg-muted mt-1 text-sm">{message}</p> : null}
      </div>
      {action}
    </div>
  );
}
