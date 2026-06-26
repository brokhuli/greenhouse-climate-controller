import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The standard control button (components §3). Variants: primary (accent), secondary (bordered),
 * danger (destructive confirmations), ghost (toolbar). Disabled keeps an accessible reason via the
 * caller's `title`/`aria-label`; coarse pointers get a 44 px hit area without changing the size.
 */
export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  children: ReactNode;
};

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-fg-on-accent hover:bg-accent-hover border border-transparent",
  secondary: "border border-border bg-surface-1 text-fg-default hover:bg-surface-3",
  danger: "bg-fault border border-transparent text-white hover:opacity-90",
  ghost: "text-fg-muted hover:bg-surface-3 hover:text-fg-default border border-transparent",
};

export function Button({ variant = "secondary", className = "", type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 text-base font-medium transition-colors duration-[var(--motion-instant)] disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASS[variant]} ${className}`}
      style={{ height: "var(--size-control-md)" }}
      {...rest}
    />
  );
}
