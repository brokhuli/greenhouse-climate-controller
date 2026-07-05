import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ApiError } from "../../api/client";
import { useCreateProfile, useUpdateProfile } from "../../api/queries/profiles";
import type { CropProfile, Setpoints, ZoneTargets } from "../../api/schemas";
import { Button } from "../../components/ui/Button";
import { TextField } from "../../components/ui/TextField";
import { useToast } from "../../components/ui/toast-context";

/**
 * Create/edit a crop profile (2b, platform §1): a name/crop plus one or more growth stages, each a
 * full setpoint bundle. Bounds are enforced by the platform on save; a 422 is surfaced with the
 * offending field. The profile id is immutable, so it is editable only when creating.
 */
type NumericKey =
  | "temperatureDayC"
  | "temperatureNightC"
  | "humidityLowPct"
  | "humidityHighPct"
  | "humidityDeadbandPct"
  | "co2TargetPpm"
  | "co2VentInterlockThresholdPct"
  | "vpdTargetKpa"
  | "dliTargetMol";

const SCALARS: { key: NumericKey; label: string; step: string }[] = [
  { key: "temperatureDayC", label: "Day temp (°C)", step: "0.1" },
  { key: "temperatureNightC", label: "Night temp (°C)", step: "0.1" },
  { key: "humidityLowPct", label: "Humidity low (%RH)", step: "1" },
  { key: "humidityHighPct", label: "Humidity high (%RH)", step: "1" },
  { key: "humidityDeadbandPct", label: "Humidity deadband (%RH)", step: "1" },
  { key: "co2TargetPpm", label: "CO₂ target (ppm)", step: "1" },
  { key: "co2VentInterlockThresholdPct", label: "CO₂ vent interlock (%)", step: "1" },
  { key: "vpdTargetKpa", label: "VPD target (kPa)", step: "0.1" },
  { key: "dliTargetMol", label: "DLI target (mol)", step: "0.1" },
];

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
  const [stages, setStages] = useState(
    existing?.stages ?? [{ stage: "vegetative", targets: defaultTargets() }],
  );
  const [formError, setFormError] = useState<string | null>(null);

  const setStage = (index: number, next: { stage?: string; targets?: Setpoints }) =>
    setStages((prev) => prev.map((stage, i) => (i === index ? { ...stage, ...next } : stage)));

  const setTarget = (index: number, key: NumericKey, value: number) =>
    setStages((prev) =>
      prev.map((stage, i) =>
        i === index ? { ...stage, targets: { ...stage.targets, [key]: value } } : stage,
      ),
    );

  const setZones = (index: number, zones: ZoneTargets[]) =>
    setStages((prev) =>
      prev.map((stage, i) =>
        i === index ? { ...stage, targets: { ...stage.targets, zones } } : stage,
      ),
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
              {SCALARS.map((field) => (
                <TextField
                  key={field.key}
                  label={field.label}
                  type="number"
                  step={field.step}
                  name={`stage-${index}-${field.key}`}
                  value={stage.targets[field.key]}
                  onChange={(e) => setTarget(index, field.key, Number(e.target.value))}
                />
              ))}
            </div>

            <ZoneEditor zones={stage.targets.zones} onChange={(zones) => setZones(index, zones)} />
          </div>
        ))}

        <div>
          <Button
            variant="secondary"
            onClick={() => setStages((prev) => [...prev, { stage: "", targets: defaultTargets() }])}
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
