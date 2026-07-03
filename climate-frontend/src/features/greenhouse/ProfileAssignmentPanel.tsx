import { useEffect, useId, useMemo, useState } from "react";
import { ApiError } from "../../api/client";
import { useAssignment, useProfiles, useSetAssignment } from "../../api/queries/profiles";
import { useRole } from "../../hooks/useRole";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/Card";
import { PanelHeader } from "../../components/ui/PanelHeader";
import { useToast } from "../../components/ui/toast-context";

const SELECT_CLASS =
  "border-border bg-surface-2 text-fg-default focus:border-accent min-w-0 rounded-md border px-2 text-sm outline-none";
const SELECT_STYLE = { height: "var(--size-control-sm)" };

/**
 * The crop-profile assignment for one greenhouse (2b, platform section 1): shows the active
 * profile/stage and lets an operator reassign one. Assigning resolves the stage targets and applies
 * them to the controller through reconciliation.
 */
export function ProfileAssignmentPanel({ greenhouseId }: { greenhouseId: string }) {
  const profileSelectId = useId();
  const stageSelectId = useId();
  const toast = useToast();
  const { isOperator } = useRole();
  const profiles = useProfiles();
  const assignment = useAssignment(greenhouseId);
  const setAssignment = useSetAssignment(greenhouseId);

  const library = useMemo(() => profiles.data ?? [], [profiles.data]);
  const current = assignment.data ?? null;

  const [profileId, setProfileId] = useState("");
  const [stage, setStage] = useState("");

  // Seed the selectors from the current assignment or the first available profile once loaded.
  useEffect(() => {
    if (current) {
      setProfileId(current.profileId);
      setStage(current.stage);
    } else if (library.length > 0) {
      setProfileId((prev) => prev || library[0].id);
    }
  }, [current, library]);

  const selectedProfile = library.find((profile) => profile.id === profileId);
  const stages = useMemo(() => selectedProfile?.stages ?? [], [selectedProfile]);

  // Keep the stage selection valid for the chosen profile.
  useEffect(() => {
    if (stages.length > 0 && !stages.some((s) => s.stage === stage)) {
      setStage(stages[0].stage);
    }
  }, [stages, stage]);

  const apply = () => {
    if (!profileId || !stage) return;
    setAssignment.mutate(
      { profileId, stage },
      {
        onSuccess: () =>
          toast.push({
            variant: "success",
            title: "Profile assigned",
            message: `${profileId} - ${stage}`,
          }),
        onError: (error) => {
          const message =
            error instanceof ApiError && error.validation
              ? `${error.validation.field}: ${error.validation.bound}`
              : error instanceof Error
                ? error.message
                : "Assignment failed";
          toast.push({ variant: "warning", title: "Couldn't assign profile", message });
        },
      },
    );
  };

  const unchanged = current?.profileId === profileId && current?.stage === stage;

  return (
    <Card>
      <PanelHeader
        title="Crop profile"
        sectionLabel
        titleSize="large"
        actions={
          library.length > 0 ? (
            <Button
              variant="primary"
              onClick={apply}
              disabled={setAssignment.isPending || unchanged || !profileId || !stage || !isOperator}
              title={isOperator ? undefined : "Operator role required"}
            >
              {setAssignment.isPending ? "Applying..." : "Apply profile"}
            </Button>
          ) : null
        }
      />

      <p className="sr-only">
        {current ? `Assigned: ${current.profileId} - ${current.stage}` : "No profile assigned."}
      </p>
      {current ? <span className="sr-only">{current.profileId}</span> : null}

      {library.length === 0 ? (
        <p className="text-fg-subtle text-sm">Create a crop profile to assign one here.</p>
      ) : (
        <div className="flex flex-col">
          <div className="border-divider grid grid-cols-[minmax(5.5rem,0.8fr)_minmax(0,1.2fr)] items-center gap-3 border-b py-2">
            <label className="text-fg-default text-sm font-medium" htmlFor={profileSelectId}>
              Profile
            </label>
            <select
              id={profileSelectId}
              className={SELECT_CLASS}
              style={SELECT_STYLE}
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              {library.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </div>

          <div className="border-divider grid grid-cols-[minmax(5.5rem,0.8fr)_minmax(0,1.2fr)] items-center gap-3 border-b py-2">
            <label className="text-fg-default text-sm font-medium" htmlFor={stageSelectId}>
              Growth stage
            </label>
            <select
              id={stageSelectId}
              className={SELECT_CLASS}
              style={SELECT_STYLE}
              value={stage}
              onChange={(e) => setStage(e.target.value)}
            >
              {stages.map((s) => (
                <option key={s.stage} value={s.stage}>
                  {s.stage}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </Card>
  );
}
