import { Clock, Pencil, Trash2 } from "lucide-react";
import type { CropProfile } from "../../api/schemas";
import { Card } from "../../components/Card";
import { Button } from "../../components/ui/Button";
import { dayWindow, stageSummary } from "./stageTargets";

/**
 * The profile-detail pane (profiles §master–detail, middle column): the selected profile's identity
 * and Edit/Delete actions, plus its growth stages as a selectable list — each with its day window and
 * a condensed target summary. Selecting a stage drives the StageTargetsPanel on the right.
 */
export function ProfileStagesPanel({
  profile,
  selectedStageIndex,
  onSelectStage,
  onEdit,
  onDelete,
  canEdit,
  operatorReason,
}: {
  profile: CropProfile;
  selectedStageIndex: number;
  onSelectStage: (index: number) => void;
  onEdit: () => void;
  onDelete: () => void;
  canEdit: boolean;
  operatorReason?: string;
}) {
  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-fg-default truncate text-lg font-semibold">{profile.name}</h2>
          <p className="text-fg-muted text-sm">
            <span className="capitalize">{profile.crop}</span>
            <span aria-hidden> · </span>
            {profile.stages.length} {profile.stages.length === 1 ? "stage" : "stages"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" onClick={onEdit} disabled={!canEdit} title={operatorReason}>
            <Pencil size={15} aria-hidden />
            Edit
          </Button>
          <Button variant="danger" onClick={onDelete} disabled={!canEdit} title={operatorReason}>
            <Trash2 size={15} aria-hidden />
            Delete
          </Button>
        </div>
      </div>

      <ul className="flex flex-col" style={{ gap: "var(--space-2)" }}>
        {profile.stages.map((stage, index) => {
          const selected = index === selectedStageIndex;
          return (
            <li key={stage.stage}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelectStage(index)}
                className={`w-full rounded-md border p-3 text-left transition-colors duration-[var(--motion-instant)] ${
                  selected
                    ? "border-accent bg-surface-2"
                    : "border-border bg-surface-1 hover:bg-surface-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${
                      selected ? "bg-accent text-fg-on-accent" : "bg-surface-3 text-fg-muted"
                    }`}
                    aria-hidden
                  >
                    {index + 1}
                  </span>
                  <span className="text-fg-default truncate text-sm font-semibold capitalize">
                    {stage.stage}
                  </span>
                  <span className="text-fg-subtle ml-auto flex shrink-0 items-center gap-1 text-xs tabular-nums">
                    <Clock size={12} aria-hidden />
                    {dayWindow(stage.targets)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {stageSummary(stage.targets).map((chip) => (
                    <span
                      key={chip.label}
                      className="border-border bg-surface-1 text-fg-muted inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                    >
                      <span className="text-fg-subtle">{chip.label}</span>
                      <span className="text-fg-default font-medium tabular-nums">{chip.value}</span>
                    </span>
                  ))}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
