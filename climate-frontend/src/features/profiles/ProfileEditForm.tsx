import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ApiError } from "../../api/client";
import { useCreateProfile, useUpdateProfile } from "../../api/queries/profiles";
import type {
  Bound,
  CropProfile,
  ProfileStage,
  ScalarSetpointKey,
  Setpoints,
  StageBounds,
  ZoneBoundKey,
  ZoneBounds,
  ZoneTargets,
} from "../../api/schemas";
import { Button } from "../../components/ui/Button";
import { TextField } from "../../components/ui/TextField";
import { useToast } from "../../components/ui/toast-context";

/**
 * Create/edit a crop profile (2b, platform §1): a name/crop plus one or more growth stages, each a
 * full setpoint bundle and a crop-safe envelope (min/max per scalar target) the optimizer may refine
 * within. The envelope must contain its target; the platform re-validates on save and a 422 is
 * surfaced with the offending field. The profile id is immutable, so it is editable only when creating.
 */
type ScalarField = {
  key: ScalarSetpointKey;
  label: string;
  step: string;
  min: number;
  max: number;
  margin: number; // default half-width of the crop-safe envelope seeded around the target
};

const SCALARS: ScalarField[] = [
  { key: "temperatureDayC", label: "Day temp (°C)", step: "0.1", min: -20, max: 60, margin: 3 },
  { key: "temperatureNightC", label: "Night temp (°C)", step: "0.1", min: -20, max: 60, margin: 3 },
  { key: "humidityLowPct", label: "Humidity low (%RH)", step: "1", min: 0, max: 100, margin: 5 },
  { key: "humidityHighPct", label: "Humidity high (%RH)", step: "1", min: 0, max: 100, margin: 5 },
  {
    key: "humidityDeadbandPct",
    label: "Humidity deadband (%RH)",
    step: "1",
    min: 0,
    max: 50,
    margin: 2,
  },
  { key: "co2TargetPpm", label: "CO₂ target (ppm)", step: "1", min: 0, max: 5000, margin: 150 },
  {
    key: "co2VentInterlockThresholdPct",
    label: "CO₂ vent interlock (%)",
    step: "1",
    min: 0,
    max: 100,
    margin: 5,
  },
  {
    key: "vpdTargetKpa",
    label: "VPD target (kPa)",
    step: "0.1",
    min: 0,
    max: Infinity,
    margin: 0.2,
  },
  { key: "dliTargetMol", label: "DLI target (mol)", step: "0.1", min: 0, max: Infinity, margin: 3 },
];

const round2 = (value: number) => Math.round(value * 100) / 100;

// defaultBound seeds a crop-safe envelope around a target, clamped to the field's physical range so
// the envelope always contains its (in-range) target.
function defaultBound(field: ScalarField, target: number): Bound {
  return {
    min: round2(Math.max(field.min, target - field.margin)),
    max: round2(Math.min(field.max, target + field.margin)),
  };
}

// The numeric per-zone irrigation targets that can carry a crop-safe envelope. The envelope is uniform
// per stage (applied to every zone), so its inputs live at stage level, not per zone. schedule carries
// no envelope (time-of-day, like the day window).
type ZoneBoundField = {
  key: ZoneBoundKey;
  label: string;
  step: string;
  min: number;
  max: number;
  margin: number;
};

const ZONE_BOUND_FIELDS: ZoneBoundField[] = [
  {
    key: "moistureLowThreshold",
    label: "Moisture low (VWC)",
    step: "0.01",
    min: 0,
    max: 1,
    margin: 0.1,
  },
  {
    key: "moistureHighThreshold",
    label: "Moisture high (VWC)",
    step: "0.01",
    min: 0,
    max: 1,
    margin: 0.1,
  },
  {
    key: "drainPeriodSecs",
    label: "Drain period (s)",
    step: "1",
    min: 0,
    max: Infinity,
    margin: 120,
  },
];

// defaultZoneBound seeds a zone-target envelope wide enough to contain every zone's value for that
// field, clamped to the field's physical range.
function defaultZoneBound(field: ZoneBoundField, zones: ZoneTargets[]): Bound {
  const values = zones.map((zone) => zone[field.key]);
  return {
    min: round2(Math.max(field.min, Math.min(...values) - field.margin)),
    max: round2(Math.min(field.max, Math.max(...values) + field.margin)),
  };
}

// seedZoneBounds returns the stage's per-zone envelope: existing bounds where set, else one seeded to
// contain all zones. undefined when the stage has no zones (nothing to envelope).
function seedZoneBounds(zones: ZoneTargets[], existing?: ZoneBounds): ZoneBounds | undefined {
  if (zones.length === 0) return undefined;
  const bounds: ZoneBounds = {};
  for (const field of ZONE_BOUND_FIELDS) {
    bounds[field.key] = existing?.[field.key] ?? defaultZoneBound(field, zones);
  }
  return bounds;
}

// fullBounds returns a complete envelope for a stage: an existing per-target bound where set, else one
// seeded around the target. Keeps the editor's envelope inputs populated even for pre-envelope profiles.
function fullBounds(targets: Setpoints, existing?: StageBounds): StageBounds {
  const bounds: StageBounds = {};
  for (const field of SCALARS) {
    bounds[field.key] = existing?.[field.key] ?? defaultBound(field, targets[field.key]);
  }
  const zones = seedZoneBounds(targets.zones, existing?.zones);
  if (zones) bounds.zones = zones;
  return bounds;
}

function defaultTargets(): Setpoints {
  return {
    temperatureDayC: 22,
    temperatureNightC: 18,
    dayStart: "06:00",
    dayEnd: "20:00",
    humidityLowPct: 50,
    humidityHighPct: 80,
    humidityDeadbandPct: 5,
    co2TargetPpm: 800,
    co2VentInterlockThresholdPct: 20,
    vpdTargetKpa: 1.0,
    dliTargetMol: 15,
    zones: [],
  };
}

function defaultZone(): ZoneTargets {
  return {
    zoneId: "",
    moistureLowThreshold: 0.3,
    moistureHighThreshold: 0.6,
    drainPeriodSecs: 600,
    schedule: "06:00",
  };
}

// A slug guard mirroring RFC-007 so the create form fails fast before the round-trip.
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function ProfileEditForm({
  existing,
  onClose,
}: {
  existing?: CropProfile;
  onClose: () => void;
}) {
  const toast = useToast();
  const isEdit = existing !== undefined;
  const create = useCreateProfile();
  const update = useUpdateProfile();
  const mutation = isEdit ? update : create;

  const [id, setId] = useState(existing?.id ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [crop, setCrop] = useState(existing?.crop ?? "");
  // The editor always manages a complete envelope so its min/max inputs stay populated, seeding one
  // from the target for any stage (or pre-envelope profile) that lacks it.
  const [stages, setStages] = useState<ProfileStage[]>(() =>
    (existing?.stages ?? [{ stage: "vegetative", targets: defaultTargets() }]).map((stage) => ({
      ...stage,
      bounds: fullBounds(stage.targets, stage.bounds),
    })),
  );
  const [formError, setFormError] = useState<string | null>(null);

  const setStage = (index: number, next: { stage?: string; targets?: Setpoints }) =>
    setStages((prev) => prev.map((stage, i) => (i === index ? { ...stage, ...next } : stage)));

  const setTarget = (index: number, key: ScalarSetpointKey, value: number) =>
    setStages((prev) =>
      prev.map((stage, i) =>
        i === index ? { ...stage, targets: { ...stage.targets, [key]: value } } : stage,
      ),
    );

  const setBound = (index: number, key: ScalarSetpointKey, edge: "min" | "max", value: number) =>
    setStages((prev) =>
      prev.map((stage, i) => {
        if (i !== index) return stage;
        const current = stage.bounds?.[key] ?? { min: value, max: value };
        return { ...stage, bounds: { ...stage.bounds, [key]: { ...current, [edge]: value } } };
      }),
    );

  const setZoneBound = (index: number, key: ZoneBoundKey, edge: "min" | "max", value: number) =>
    setStages((prev) =>
      prev.map((stage, i) => {
        if (i !== index) return stage;
        const zones = stage.bounds?.zones ?? {};
        const current = zones[key] ?? { min: value, max: value };
        return {
          ...stage,
          bounds: { ...stage.bounds, zones: { ...zones, [key]: { ...current, [edge]: value } } },
        };
      }),
    );

  // Changing the zones re-seeds the per-zone envelope (keeping any bounds already set), and drops it
  // when the last zone is removed — mirroring how the climate envelope always stays populated.
  const setZones = (index: number, zones: ZoneTargets[]) =>
    setStages((prev) =>
      prev.map((stage, i) => {
        if (i !== index) return stage;
        const bounds: StageBounds = { ...stage.bounds };
        const seeded = seedZoneBounds(zones, stage.bounds?.zones);
        if (seeded) bounds.zones = seeded;
        else delete bounds.zones;
        return { ...stage, targets: { ...stage.targets, zones }, bounds };
      }),
    );

  const submit = () => {
    setFormError(null);
    if (!isEdit && !SLUG.test(id)) {
      setFormError("Profile id must be a lowercase kebab slug (e.g. lettuce).");
      return;
    }
    if (name.trim() === "" || crop.trim() === "") {
      setFormError("Name and crop are required.");
      return;
    }
    if (stages.length === 0 || stages.some((stage) => stage.stage.trim() === "")) {
      setFormError("Every stage needs a non-empty name.");
      return;
    }
    // Mirror the platform's crop-safe-envelope invariants so a bad range fails fast: min ≤ max and the
    // target must fall inside its own envelope.
    for (const stage of stages) {
      for (const field of SCALARS) {
        const bound = stage.bounds?.[field.key];
        if (!bound) continue;
        if (bound.min > bound.max) {
          setFormError(`${stage.stage} · ${field.label}: crop-safe min must be ≤ max.`);
          return;
        }
        const target = stage.targets[field.key];
        if (target < bound.min || target > bound.max) {
          setFormError(
            `${stage.stage} · ${field.label}: target ${target} is outside its crop-safe range [${bound.min}, ${bound.max}].`,
          );
          return;
        }
      }
      // The per-zone envelope is uniform, so it must contain every zone's target for each bounded field.
      const zoneBounds = stage.bounds?.zones;
      if (zoneBounds) {
        for (const field of ZONE_BOUND_FIELDS) {
          const bound = zoneBounds[field.key];
          if (!bound) continue;
          if (bound.min > bound.max) {
            setFormError(`${stage.stage} · zone ${field.label}: crop-safe min must be ≤ max.`);
            return;
          }
          for (const zone of stage.targets.zones) {
            const target = zone[field.key];
            if (target < bound.min || target > bound.max) {
              setFormError(
                `${stage.stage} · zone ${field.label}: ${zone.zoneId || "a zone"}'s target ${target} is outside its crop-safe range [${bound.min}, ${bound.max}].`,
              );
              return;
            }
          }
        }
      }
    }
    const profile: CropProfile = { id, name, crop, stages };
    mutation.mutate(profile, {
      onSuccess: () => {
        toast.push({
          variant: "success",
          title: isEdit ? "Profile updated" : "Profile created",
          message: name,
        });
        onClose();
      },
      onError: (error) => {
        if (error instanceof ApiError && error.kind === "validation" && error.validation) {
          setFormError(`${error.validation.field}: ${error.validation.bound}`);
        } else {
          setFormError(error instanceof Error ? error.message : "Save failed");
        }
      },
    });
  };

  return (
    <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <TextField
          label="Profile id"
          name="profile-id"
          value={id}
          disabled={isEdit}
          hint={isEdit ? undefined : "lowercase-kebab"}
          onChange={(e) => setId(e.target.value)}
        />
        <TextField
          label="Name"
          name="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="Crop"
          name="profile-crop"
          value={crop}
          onChange={(e) => setCrop(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-4">
        {stages.map((stage, index) => (
          <div key={index} className="border-border flex flex-col gap-3 rounded-md border p-3">
            <div className="flex items-end justify-between gap-2">
              <div className="grow">
                <TextField
                  label={`Stage ${index + 1}`}
                  name={`stage-${index}`}
                  value={stage.stage}
                  hint="e.g. propagation, vegetative, fruiting"
                  onChange={(e) => setStage(index, { stage: e.target.value })}
                />
              </div>
              {stages.length > 1 ? (
                <Button
                  variant="ghost"
                  aria-label={`Remove stage ${index + 1}`}
                  onClick={() => setStages((prev) => prev.filter((_, i) => i !== index))}
                >
                  <Trash2 size={16} aria-hidden />
                </Button>
              ) : null}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField
                label="Day start"
                type="time"
                name={`stage-${index}-day-start`}
                value={stage.targets.dayStart}
                onChange={(e) =>
                  setStage(index, { targets: { ...stage.targets, dayStart: e.target.value } })
                }
              />
              <TextField
                label="Day end"
                type="time"
                name={`stage-${index}-day-end`}
                value={stage.targets.dayEnd}
                onChange={(e) =>
                  setStage(index, { targets: { ...stage.targets, dayEnd: e.target.value } })
                }
              />
            </div>

            <div className="flex flex-col gap-2">
              <p className="section-label">Targets & crop-safe range</p>
              <p className="text-fg-muted text-xs">
                The optimizer may refine each target within its crop-safe min/max; the target itself
                must sit inside the range.
              </p>
              {SCALARS.map((field) => {
                const bound = stage.bounds?.[field.key];
                return (
                  <div
                    key={field.key}
                    className="grid grid-cols-1 gap-2 sm:grid-cols-[1.4fr_1fr_1fr]"
                  >
                    <TextField
                      label={field.label}
                      type="number"
                      step={field.step}
                      name={`stage-${index}-${field.key}`}
                      value={stage.targets[field.key]}
                      onChange={(e) => setTarget(index, field.key, Number(e.target.value))}
                    />
                    <TextField
                      label="Crop-safe min"
                      type="number"
                      step={field.step}
                      name={`stage-${index}-${field.key}-min`}
                      value={bound?.min ?? ""}
                      onChange={(e) => setBound(index, field.key, "min", Number(e.target.value))}
                    />
                    <TextField
                      label="Crop-safe max"
                      type="number"
                      step={field.step}
                      name={`stage-${index}-${field.key}-max`}
                      value={bound?.max ?? ""}
                      onChange={(e) => setBound(index, field.key, "max", Number(e.target.value))}
                    />
                  </div>
                );
              })}
            </div>

            <ZoneEditor zones={stage.targets.zones} onChange={(zones) => setZones(index, zones)} />

            {stage.targets.zones.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="section-label">Zone irrigation crop-safe range</p>
                <p className="text-fg-muted text-xs">
                  The optimizer may refine every zone's irrigation targets within these bounds; each
                  zone's target must sit inside the range.
                </p>
                {ZONE_BOUND_FIELDS.map((field) => {
                  const bound = stage.bounds?.zones?.[field.key];
                  return (
                    <div
                      key={field.key}
                      className="grid grid-cols-1 gap-2 sm:grid-cols-[1.4fr_1fr_1fr]"
                    >
                      <div className="text-fg-muted flex items-end pb-2 text-sm">{field.label}</div>
                      <TextField
                        label="Crop-safe min"
                        type="number"
                        step={field.step}
                        name={`stage-${index}-zone-${field.key}-min`}
                        value={bound?.min ?? ""}
                        onChange={(e) =>
                          setZoneBound(index, field.key, "min", Number(e.target.value))
                        }
                      />
                      <TextField
                        label="Crop-safe max"
                        type="number"
                        step={field.step}
                        name={`stage-${index}-zone-${field.key}-max`}
                        value={bound?.max ?? ""}
                        onChange={(e) =>
                          setZoneBound(index, field.key, "max", Number(e.target.value))
                        }
                      />
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ))}

        <div>
          <Button
            variant="secondary"
            onClick={() =>
              setStages((prev) => {
                const targets = defaultTargets();
                return [...prev, { stage: "", targets, bounds: fullBounds(targets) }];
              })
            }
          >
            <Plus size={16} aria-hidden />
            Add stage
          </Button>
        </div>
      </div>

      {formError ? (
        <p role="alert" className="text-fault text-sm">
          {formError}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : isEdit ? "Save changes" : "Create profile"}
        </Button>
      </div>
    </div>
  );
}

function ZoneEditor({
  zones,
  onChange,
}: {
  zones: ZoneTargets[];
  onChange: (zones: ZoneTargets[]) => void;
}) {
  const setZone = (index: number, next: Partial<ZoneTargets>) =>
    onChange(zones.map((zone, i) => (i === index ? { ...zone, ...next } : zone)));

  return (
    <div className="flex flex-col gap-2">
      <p className="section-label">Irrigation zones (optional)</p>
      {zones.map((zone, index) => (
        <div
          key={index}
          className="border-border grid grid-cols-1 gap-2 rounded-md border p-2 sm:grid-cols-2"
        >
          <TextField
            label="Zone id"
            name={`zone-${index}-id`}
            value={zone.zoneId}
            onChange={(e) => setZone(index, { zoneId: e.target.value })}
          />
          <TextField
            label="Schedule (HH:MM,…)"
            name={`zone-${index}-schedule`}
            value={zone.schedule}
            onChange={(e) => setZone(index, { schedule: e.target.value })}
          />
          <TextField
            label="Moisture low (VWC)"
            type="number"
            step="0.01"
            name={`zone-${index}-low`}
            value={zone.moistureLowThreshold}
            onChange={(e) => setZone(index, { moistureLowThreshold: Number(e.target.value) })}
          />
          <TextField
            label="Moisture high (VWC)"
            type="number"
            step="0.01"
            name={`zone-${index}-high`}
            value={zone.moistureHighThreshold}
            onChange={(e) => setZone(index, { moistureHighThreshold: Number(e.target.value) })}
          />
          <TextField
            label="Drain period (s)"
            type="number"
            step="1"
            name={`zone-${index}-drain`}
            value={zone.drainPeriodSecs}
            onChange={(e) => setZone(index, { drainPeriodSecs: Number(e.target.value) })}
          />
          <div className="flex items-end">
            <Button
              variant="ghost"
              aria-label={`Remove zone ${index + 1}`}
              onClick={() => onChange(zones.filter((_, i) => i !== index))}
            >
              <Trash2 size={16} aria-hidden />
              Remove zone
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button variant="ghost" onClick={() => onChange([...zones, defaultZone()])}>
          <Plus size={16} aria-hidden />
          Add zone
        </Button>
      </div>
    </div>
  );
}
