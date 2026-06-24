import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Wraps the routed views so a render error degrades to an error card without taking down the
 * shell or sibling routes (architecture §9).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("View crashed:", error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        className="border-border bg-surface-1 rounded-lg border"
        style={{ padding: "var(--space-5)" }}
      >
        <h2 className="text-md text-fault font-semibold">Something went wrong</h2>
        <p className="text-fg-muted mt-2 text-sm">{error.message}</p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="border-border text-fg-default hover:bg-surface-3 mt-4 rounded-md border px-3 py-1 text-sm"
        >
          Try again
        </button>
      </div>
    );
  }
}
