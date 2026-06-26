import type { ReactNode } from "react";

/**
 * Shared header row for cards/panels (components §3): a title (optionally a section-label), an
 * optional value, and right-aligned compact actions in a fixed-height row so toolbar changes don't
 * move content.
 */
export function PanelHeader({
  title,
  value,
  actions,
  sectionLabel = false,
}: {
  title: string;
  value?: ReactNode;
  actions?: ReactNode;
  sectionLabel?: boolean;
}) {
  return (
    <div className="mb-3 flex min-h-[var(--size-control-md)] items-center justify-between gap-3">
      <div className="flex items-baseline gap-2">
        <h3 className={sectionLabel ? "section-label" : "text-fg-default text-base font-semibold"}>
          {title}
        </h3>
        {value !== undefined ? <span className="text-fg-muted text-sm">{value}</span> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
