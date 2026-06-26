import { forwardRef, type InputHTMLAttributes } from "react";

/**
 * A labeled text/number input with inline validation messaging (interactions §10: validate on
 * blur + submit; errors announced via `aria-live`). Forwards its ref so it drops straight into
 * `react-hook-form`'s `register()`.
 */
type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  hint?: string;
};

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, hint, id, name, className = "", ...rest },
  ref,
) {
  const inputId = id ?? name;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-fg-default text-sm font-medium">
        {label}
      </label>
      <input
        id={inputId}
        name={name}
        ref={ref}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`border-border bg-surface-2 text-fg-default focus:border-accent rounded-md border px-3 text-base outline-none ${className}`}
        style={{
          height: "var(--size-control-md)",
          borderColor: error ? "var(--color-fault)" : undefined,
        }}
        {...rest}
      />
      {hint && !error ? (
        <p id={`${inputId}-hint`} className="text-fg-subtle text-xs">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${inputId}-error`} role="alert" aria-live="polite" className="text-fault text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
});
