import type { ReactNode } from "react";

/**
 * A small rounded label (crop chip, sim-speed badge, filter token). Color comes from a CSS token
 * value passed by the caller; text carries the meaning so it is never color-only.
 */
export function Pill({
  children,
  color,
  icon,
  title,
}: {
  children: ReactNode;
  color?: string;
  icon?: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="border-border bg-surface-2 text-fg-default inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
      style={color ? { color, borderColor: color } : undefined}
    >
      {icon}
      {children}
    </span>
  );
}
