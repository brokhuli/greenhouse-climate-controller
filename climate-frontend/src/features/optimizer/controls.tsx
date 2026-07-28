import { useState } from "react";
import { CircleCheck, CircleMinus, OctagonX, Pause, Play, TriangleAlert } from "lucide-react";
import type { FleetOptimizerRollup, ModelState } from "../../api/schemas";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { SummaryStat } from "../../components/ui/SummaryStat";

const GRID_STYLE = { gap: "var(--layout-card-gap)" };

/** Site-wide optimizer rollup of each greenhouse's latest cycle outcome. */
export function OptimizerRollupBar({ rollup }: { rollup: FleetOptimizerRollup }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4" style={GRID_STYLE}>
      <SummaryStat
        label="Applied"
        value={rollup.byOutcome.applied}
        caption="Setpoints published"
        Icon={CircleCheck}
        color="var(--color-status-online)"
      />
      <SummaryStat
        label="Unchanged"
        value={rollup.byOutcome.unchanged}
        caption="No change needed"
        Icon={CircleMinus}
        color="var(--color-info)"
      />
      <SummaryStat
        label="Held"
        value={rollup.byOutcome.held}
        caption="Existing setpoints kept"
        Icon={TriangleAlert}
        color="var(--color-status-degraded)"
      />
      <SummaryStat
        label="Failed"
        value={rollup.byOutcome.failed}
        caption="No valid plan produced"
        Icon={OctagonX}
        color="var(--color-fault)"
      />
    </div>
  );
}

/**
 * Select the active planning model within the active provider's allowlist. The provider and prompt
 * version are read-only (offline changes); the change takes effect on the next cycle. Operator-gated
 * by the caller (`disabled` + `disabledReason`).
 */
export function ModelSelector({
  model,
  onSelect,
  disabled = false,
  disabledReason,
  pending = false,
}: {
  model: ModelState;
  onSelect: (model: string) => void;
  disabled?: boolean;
  disabledReason?: string;
  pending?: boolean;
}) {
  return (
    <label className="flex items-center gap-2" title={disabled ? disabledReason : undefined}>
      <span className="text-fg-muted text-sm">Model</span>
      <select
        aria-label="Active planning model"
        value={model.model}
        disabled={disabled || pending}
        onChange={(event) => {
          if (event.target.value !== model.model) onSelect(event.target.value);
        }}
        className="border-border bg-surface-2 text-fg-default focus:border-accent rounded-md border px-3 text-base outline-none disabled:cursor-not-allowed disabled:opacity-50"
        style={{ height: "var(--size-control-md)" }}
      >
        {model.availableModels.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <span className="text-fg-subtle text-xs">
        {model.provider} · {model.promptVersion}
      </span>
    </label>
  );
}

/**
 * Pause / resume planning — `scope="global"` (whole service) or `scope="greenhouse"` (one greenhouse).
 * Disabling asks for confirmation (a pause stops writes); enabling is immediate. Operator-gated by the
 * caller; the per-greenhouse toggle is additionally disabled with a reason while the service is
 * globally paused (global precedence).
 */
export function OptimizerEnableToggle({
  enabled,
  scope,
  onChange,
  disabled = false,
  disabledReason,
  pending = false,
}: {
  enabled: boolean;
  scope: "global" | "greenhouse";
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
  pending?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const target = scope === "global" ? "the optimizer service" : "this greenhouse";

  if (enabled) {
    return (
      <>
        <Button
          variant="secondary"
          onClick={() => setConfirming(true)}
          disabled={disabled || pending}
          title={disabled ? disabledReason : undefined}
        >
          <Pause size={16} aria-hidden />
          {pending ? "Pausing…" : "Pause"}
        </Button>
        <Dialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title={scope === "global" ? "Pause the optimizer?" : "Pause this greenhouse?"}
          description={`Planning stops and no setpoints are written for ${target} until it is resumed. Current setpoints stay in force.`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirming(false);
                  onChange(false);
                }}
              >
                Pause
              </Button>
            </>
          }
        />
      </>
    );
  }

  return (
    <Button
      variant="primary"
      onClick={() => onChange(true)}
      disabled={disabled || pending}
      title={disabled ? disabledReason : undefined}
    >
      <Play size={16} aria-hidden />
      {pending ? "Resuming…" : "Resume"}
    </Button>
  );
}

/**
 * Run an on-demand planning cycle for one greenhouse (bypasses state-change suppression, not the
 * input/safety/application gates). Disabled while the optimizer is off — globally or for this
 * greenhouse — or a cycle is already in flight (a 409). Operator-gated by the caller.
 */
export function TriggerCycleAction({
  onTrigger,
  disabled = false,
  disabledReason,
  pending = false,
}: {
  onTrigger: () => void;
  disabled?: boolean;
  disabledReason?: string;
  pending?: boolean;
}) {
  return (
    <Button
      variant="secondary"
      onClick={onTrigger}
      disabled={disabled || pending}
      title={disabled ? disabledReason : undefined}
    >
      <Play size={16} aria-hidden />
      {pending ? "Running…" : "Run cycle"}
    </Button>
  );
}
