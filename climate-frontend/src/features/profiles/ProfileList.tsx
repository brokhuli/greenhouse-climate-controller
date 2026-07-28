import type { CropProfile } from "../../api/schemas";
import { Card } from "../../components/Card";
import { cropIcon } from "./stageTargets";

/**
 * The profile-library pane (profiles §master–detail, left column): every crop profile as a selectable
 * row with a botanical icon, name, crop, and stage count. `profiles` is the already-filtered list; the
 * selected row drives the detail panes to its right.
 */
export function ProfileList({
  profiles,
  selectedProfileId,
  onSelect,
}: {
  profiles: CropProfile[];
  selectedProfileId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card>
      <p className="section-label mb-3">Crop profiles ({profiles.length})</p>
      {profiles.length === 0 ? (
        <p className="text-fg-subtle text-sm">No profiles match your search.</p>
      ) : (
        <ul className="flex flex-col" style={{ gap: "var(--space-1)" }}>
          {profiles.map((profile) => {
            const Icon = cropIcon(profile.crop);
            const selected = profile.id === selectedProfileId;
            return (
              <li key={profile.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(profile.id)}
                  className={`flex w-full items-center gap-3 rounded-md border-l-2 py-2 pr-2 pl-2.5 text-left transition-colors duration-[var(--motion-instant)] ${
                    selected
                      ? "border-accent bg-surface-2"
                      : "hover:bg-surface-2 border-transparent"
                  }`}
                >
                  <span
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                    style={{
                      backgroundColor:
                        "color-mix(in srgb, var(--chart-temperature) 16%, transparent)",
                      color: "var(--chart-temperature)",
                    }}
                    aria-hidden
                  >
                    <Icon size={20} />
                  </span>
                  <span className="min-w-0">
                    <span className="text-fg-default block truncate text-sm font-semibold">
                      {profile.name}
                    </span>
                    <span className="text-fg-muted block truncate text-xs">
                      <span className="capitalize">{profile.crop}</span>
                      <span aria-hidden> · </span>
                      {profile.stages.length} {profile.stages.length === 1 ? "stage" : "stages"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
