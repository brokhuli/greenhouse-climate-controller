/**
 * The canonical loading placeholder (interactions §9) — a pulsing block matching the eventual
 * layout. No spinners on primary views. The pulse is suppressed under `prefers-reduced-motion`
 * by the global baseline.
 */
export function Skeleton({
  className = "",
  height,
  width,
}: {
  className?: string;
  height?: number | string;
  width?: number | string;
}) {
  return (
    <div
      aria-hidden
      className={`bg-surface-3 animate-pulse rounded-md ${className}`}
      style={{ height, width }}
    />
  );
}
