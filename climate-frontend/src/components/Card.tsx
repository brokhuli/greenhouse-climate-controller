import type { ReactNode } from "react";

/** The bordered, rounded panel that defines the dashboard look (components §3). */
export function Card({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <section
      className="border-border bg-surface-1 rounded-lg border"
      style={{ padding: "var(--space-4)" }}
    >
      {title ? (
        <h2
          className="text-md text-fg-default font-semibold"
          style={{ marginBottom: "var(--space-3)" }}
        >
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}
