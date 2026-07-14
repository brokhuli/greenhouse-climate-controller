import { Gauge } from "lucide-react";
import { Pill } from "./Pill";

/**
 * Simulation time-scale UI (components §3, sim-only). `TimeScaleIndicator` is the read-only speed
 * badge; `TimeScaleControl` is the live segmented knob (0.5/1/2/4/8×) that writes immediately
 * with no confirmation dialog (interactions §7). Both are presentational — the feature wires the
 * mutation and feeds the observed `value` from the `status` frame.
 */
const formatScale = (scale: number): string => `${scale}×`;

export function TimeScaleIndicator({ scale }: { scale: number }) {
  return (
    <Pill color="var(--color-info)" icon={<Gauge size={11} aria-hidden />} title="Simulation speed">
      {formatScale(scale)}
    </Pill>
  );
}

const OPTIONS = [0.5, 1, 2, 4, 8] as const;

export function TimeScaleControl({
  value,
  onChange,
  pending = false,
  disabled = false,
  label = "Simulation speed",
}: {
  value: number | null;
  onChange: (scale: number) => void;
  pending?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`border-border bg-surface-2 inline-flex items-center rounded-md border p-0.5 ${pending ? "opacity-60" : ""}`}
    >
      {OPTIONS.map((option) => {
        const selected = value === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled || pending}
            onClick={() => onChange(option)}
            className={`rounded-sm px-2 text-xs font-medium tabular-nums transition-colors duration-[var(--motion-instant)] disabled:cursor-not-allowed ${
              selected ? "bg-accent text-fg-on-accent" : "text-fg-muted hover:text-fg-default"
            }`}
            style={{ height: "calc(var(--size-control-sm) - 4px)" }}
          >
            {formatScale(option)}
          </button>
        );
      })}
    </div>
  );
}
