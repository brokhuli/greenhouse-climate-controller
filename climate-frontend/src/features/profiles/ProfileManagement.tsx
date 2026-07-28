import { useEffect, useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { useDeleteProfile, useProfiles } from "../../api/queries/profiles";
import type { CropProfile } from "../../api/schemas";
import { ApiError } from "../../api/client";
import { useRole } from "../../hooks/useRole";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorState } from "../../components/ui/ErrorState";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/toast-context";
import { ProfileEditForm } from "./ProfileEditForm";
import { ProfileList } from "./ProfileList";
import { ProfileStagesPanel } from "./ProfileStagesPanel";
import { StageTargetsPanel } from "./StageTargetsPanel";

const CONTROL_CLASS =
  "border-border bg-surface-2 text-fg-default focus:border-accent rounded-md border text-sm outline-none";
const CONTROL_STYLE = { height: "var(--size-control-md)" };

// Three panes on wide screens (library · stages · targets), stacking to one column below the lg
// breakpoint; the side panels take the shared side-panel width, the stage detail takes the rest.
const PANES =
  "grid grid-cols-1 items-start lg:grid-cols-[var(--layout-side-panel-width)_minmax(0,1fr)_var(--layout-side-panel-width)]";

/**
 * The crop-profile library (2b, components §6): browse the reusable stage-aware target bundles as a
 * master–detail view (library → stages → stage targets), and create, edit, and delete them. A profile
 * in use by a greenhouse cannot be deleted (the platform returns 422).
 */
export default function ProfileManagement() {
  const profiles = useProfiles();
  const { isOperator } = useRole();
  // `null` = closed; "new" = create; a profile = edit that profile.
  const [editing, setEditing] = useState<CropProfile | "new" | null>(null);
  const [deleting, setDeleting] = useState<CropProfile | null>(null);

  const [query, setQuery] = useState("");
  const [cropFilter, setCropFilter] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [selectedStageIndex, setSelectedStageIndex] = useState(0);

  const library = useMemo(() => profiles.data ?? [], [profiles.data]);
  const operatorOnly = isOperator ? undefined : "Operator role required";

  // The distinct crops in the library, for the crop filter.
  const crops = useMemo(
    () => Array.from(new Set(library.map((profile) => profile.crop))).sort(),
    [library],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return library.filter((profile) => {
      const matchesQuery =
        needle === "" ||
        profile.name.toLowerCase().includes(needle) ||
        profile.crop.toLowerCase().includes(needle);
      const matchesCrop = cropFilter === "" || profile.crop === cropFilter;
      return matchesQuery && matchesCrop;
    });
  }, [library, query, cropFilter]);

  // Keep a valid selection: default to the first visible profile, and re-anchor when the current one
  // is filtered out. Selecting a different profile resets the stage cursor to its first stage.
  useEffect(() => {
    if (filtered.length === 0) return;
    if (!selectedProfileId || !filtered.some((profile) => profile.id === selectedProfileId)) {
      setSelectedProfileId(filtered[0].id);
      setSelectedStageIndex(0);
    }
  }, [filtered, selectedProfileId]);

  const selectedProfile = filtered.find((profile) => profile.id === selectedProfileId) ?? null;
  const stageCount = selectedProfile?.stages.length ?? 0;
  const stageIndex = Math.min(selectedStageIndex, Math.max(0, stageCount - 1));
  const selectedStage = selectedProfile?.stages[stageIndex] ?? null;

  const selectProfile = (id: string) => {
    setSelectedProfileId(id);
    setSelectedStageIndex(0);
  };

  return (
    <div className="flex flex-col" style={{ gap: "var(--layout-section-gap)" }}>
      {/* Toolbar: search + crop filter on the left, create on the right. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 grow sm:grow-0">
          <Search
            size={15}
            aria-hidden
            className="text-fg-subtle pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search profiles…"
            aria-label="Search profiles"
            className={`${CONTROL_CLASS} w-full py-1 pr-2 pl-8 sm:w-64`}
            style={CONTROL_STYLE}
          />
        </div>
        <select
          value={cropFilter}
          onChange={(e) => setCropFilter(e.target.value)}
          aria-label="Filter by crop"
          className={`${CONTROL_CLASS} px-2`}
          style={CONTROL_STYLE}
        >
          <option value="">All crops</option>
          {crops.map((crop) => (
            <option key={crop} value={crop}>
              {crop}
            </option>
          ))}
        </select>
        <Button
          variant="primary"
          className="ml-auto"
          onClick={() => setEditing("new")}
          disabled={!isOperator}
          title={operatorOnly}
        >
          <Plus size={16} aria-hidden />
          New profile
        </Button>
      </div>

      {profiles.isLoading ? (
        <div className={PANES} style={{ gap: "var(--layout-card-gap)" }}>
          <Skeleton height={320} />
          <Skeleton height={320} />
          <Skeleton height={320} />
        </div>
      ) : profiles.isError ? (
        <ErrorState
          title="Couldn't load crop profiles"
          message={profiles.error?.message}
          onRetry={() => void profiles.refetch()}
        />
      ) : library.length === 0 ? (
        <EmptyState
          title="No crop profiles yet"
          message="Create a profile to assign stage-aware targets to your greenhouses."
          action={
            <Button
              variant="primary"
              onClick={() => setEditing("new")}
              disabled={!isOperator}
              title={operatorOnly}
            >
              Create profile
            </Button>
          }
        />
      ) : (
        <div className={PANES} style={{ gap: "var(--layout-card-gap)" }}>
          <ProfileList
            profiles={filtered}
            selectedProfileId={selectedProfile?.id ?? null}
            onSelect={selectProfile}
          />
          {selectedProfile ? (
            <ProfileStagesPanel
              profile={selectedProfile}
              selectedStageIndex={stageIndex}
              onSelectStage={setSelectedStageIndex}
              onEdit={() => setEditing(selectedProfile)}
              onDelete={() => setDeleting(selectedProfile)}
              canEdit={isOperator}
              operatorReason={operatorOnly}
            />
          ) : (
            <EmptyState
              title="No profiles match"
              message="Clear the search or crop filter to see the whole library."
            />
          )}
          {selectedProfile && selectedStage ? (
            <StageTargetsPanel
              stage={selectedStage}
              stageIndex={stageIndex}
              stageCount={stageCount}
              onStep={setSelectedStageIndex}
            />
          ) : null}
        </div>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        size="xl"
        title={editing === "new" || editing === null ? "New crop profile" : `Edit ${editing.name}`}
      >
        {editing !== null ? (
          <ProfileEditForm
            existing={editing === "new" ? undefined : editing}
            onClose={() => setEditing(null)}
          />
        ) : null}
      </Dialog>

      <DeleteProfileDialog profile={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function DeleteProfileDialog({
  profile,
  onClose,
}: {
  profile: CropProfile | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const remove = useDeleteProfile();

  const confirm = () => {
    if (!profile) return;
    remove.mutate(profile.id, {
      onSuccess: () => {
        toast.push({ variant: "success", title: "Profile deleted", message: profile.name });
        onClose();
      },
      onError: (error) => {
        const message =
          error instanceof ApiError && error.kind === "validation"
            ? "This profile is assigned to a greenhouse — reassign it first."
            : error instanceof Error
              ? error.message
              : "Delete failed";
        toast.push({ variant: "warning", title: "Couldn't delete profile", message });
        onClose();
      },
    });
  };

  return (
    <Dialog
      open={profile !== null}
      onClose={onClose}
      title="Delete crop profile?"
      description={profile ? `${profile.name} will be removed from the library.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} disabled={remove.isPending}>
            {remove.isPending ? "Deleting…" : "Delete"}
          </Button>
        </>
      }
    />
  );
}
