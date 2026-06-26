import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import {
  ToastContext,
  type ToastApi,
  type ToastInput,
  type ToastRecord,
  type ToastVariant,
} from "./toast-context";

/**
 * Holds the toast queue and renders the stack (interactions §8). Critical toasts persist until
 * acknowledged and announce assertively; the rest auto-dismiss and announce politely. A toast is
 * never the only record of a fault — it also lands in the ActivityFeed.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput): string => {
      counter.current += 1;
      const id = `toast-${counter.current}`;
      const variant = input.variant ?? "info";
      setToasts((prev) => [...prev, { ...input, id, variant }]);

      const duration = input.durationMs ?? (variant === "critical" ? 0 : 5000);
      if (duration > 0) window.setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

const VARIANT_META: Record<ToastVariant, { color: string; Icon: typeof Info; assertive: boolean }> =
  {
    info: { color: "var(--color-info)", Icon: Info, assertive: false },
    success: { color: "var(--color-status-online)", Icon: CheckCircle2, assertive: false },
    warning: { color: "var(--color-warning)", Icon: AlertTriangle, assertive: false },
    critical: { color: "var(--color-fault)", Icon: XCircle, assertive: true },
  };

function ToastHost({
  toasts,
  onDismiss,
}: {
  toasts: ToastRecord[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 flex w-80 flex-col gap-2"
      style={{ zIndex: "var(--z-toast)" }}
    >
      {toasts.map((toast) => {
        const { color, Icon, assertive } = VARIANT_META[toast.variant];
        return (
          <div
            key={toast.id}
            role={assertive ? "alert" : "status"}
            aria-live={assertive ? "assertive" : "polite"}
            className="border-border bg-surface-raised text-fg-default pointer-events-auto flex items-start gap-3 rounded-lg border p-3 shadow-[var(--shadow-md)]"
          >
            <Icon size={16} aria-hidden style={{ color, marginTop: 2 }} />
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium">{toast.title}</p>
              {toast.message ? (
                <p className="text-fg-muted mt-0.5 text-sm">{toast.message}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss notification"
              className="text-fg-subtle hover:text-fg-default shrink-0"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
