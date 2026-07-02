import { useState } from "react";
import { Plus } from "lucide-react";
import { useDeleteProfile, useProfiles } from "../../api/queries/profiles";
import type { CropProfile } from "../../api/schemas";
import { ApiError } from "../../api/client";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/Card";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorState } from "../../components/ui/ErrorState";
import { Pill } from "../../components/ui/Pill";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/toast-context";
import { ProfileEditForm } from "./ProfileEditForm";

const GRID = "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
const GRID_STYLE = { gap: "var(--layout-card-gap)" };

/**
 * The crop-profile library (2b, components §6): create, edit, and delete the reusable
 * stage-aware target bundles operators assign to greenhouses. A profile in use by a greenhouse
 * cannot be deleted (the platform returns 422).
 */
export default function ProfileManagement() {
  const profiles = useProfiles();
  // `null` = closed; "new" = create; a profile = edit that profile.
  const [editing, setEditing] = useState<CropProfile | "new" | null>(null);
  const [deleting, setDeleting] = useState<CropProfile | null>(null);

  const library = profiles.data ?? [];

  return (
    <div className="flex flex-col" style={{ gap: "var(--layout-section-gap)" }}>
      <div className="flex items-center justify-end">
        <Button variant="primary" onClick={() => setEditing("new")}>
          <Plus size={16} aria-hidden />
          New profile
        </Button>
      </div>

      {profiles.isLoading ? (
        <div className={GRID} style={GRID_STYLE}>
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} height={140} />
          ))}
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
            <Button variant="primary" onClick={() => setEditing("new")}>
              Create profile
            </Button>
          }
        />
      ) : (
        <div className={GRID} style={GRID_STYLE}>
          {library.map((profile) => (
            <Card key={profile.id}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-fg-default truncate text-base font-semibold">{profile.name}</p>
                  <p className="text-fg-muted text-sm">{profile.crop}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {profile.stages.map((stage) => (
                  <Pill key={stage.stage}>{stage.stage}</Pill>
                ))}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setEditing(profile)}>
                  Edit
                </Button>
                <Button variant="danger" onClick={() => setDeleting(profile)}>
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
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
