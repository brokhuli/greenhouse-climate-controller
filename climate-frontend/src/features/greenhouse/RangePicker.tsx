import { RANGE_OPTIONS, type RangeKey } from "./range";

/**
 * Choose the historical window for the detail charts (components §3). The selection is the
 * deep-linkable `?range=` query param, owned by the container.
 */
export function RangePicker({
  value,
  onChange,
}: {
  value: RangeKey;
  onChange: (value: RangeKey) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className="border-border bg-surface-2 inline-flex items-center rounded-md border p-0.5"
    >
      {RANGE_OPTIONS.map((option) => {
        const selected = value === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option)}
            className={`rounded-sm px-2 text-xs font-medium tabular-nums transition-colors duration-[var(--motion-instant)] ${
              selected ? "bg-accent text-fg-on-accent" : "text-fg-muted hover:text-fg-default"
            }`}
            style={{ height: "calc(var(--size-control-sm) - 4px)" }}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}
