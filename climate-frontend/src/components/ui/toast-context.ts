import { createContext, useContext } from "react";

/**
 * The toast queue API (interactions §8). Split from the provider component so a Fast-Refresh
 * boundary stays clean (mirrors the theme context split). `useToast` is the only way features
 * raise transient notifications — write confirmations, fault/critical alerts, and errors.
 */

export type ToastVariant = "info" | "success" | "warning" | "critical";

export type ToastInput = {
  variant?: ToastVariant;
  title: string;
  message?: string;
  /** ms before auto-dismiss; `0` persists until dismissed. Defaults: critical → persist, else 5 s. */
  durationMs?: number;
};

export type ToastRecord = ToastInput & { id: string; variant: ToastVariant };

export type ToastApi = {
  push: (toast: ToastInput) => string;
  dismiss: (id: string) => void;
};

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within a ToastProvider");
  return context;
}
