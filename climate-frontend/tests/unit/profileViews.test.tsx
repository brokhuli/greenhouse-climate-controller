import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import ProfileManagement from "../../src/features/profiles/ProfileManagement";
import { ProfileEditForm } from "../../src/features/profiles/ProfileEditForm";
import { ProfileAssignmentPanel } from "../../src/features/greenhouse/ProfileAssignmentPanel";
import { queryKeys } from "../../src/api/queries/keys";
import type { Assignment, CropProfile, Setpoints } from "../../src/api/schemas";
import { makeClient, renderWithProviders } from "../utils";

const targets = (): Setpoints => ({
  temperatureDayC: 24,
  temperatureNightC: 18,
  dayStart: "06:00",
  dayEnd: "20:00",
  humidityLowPct: 55,
  humidityHighPct: 80,
  humidityDeadbandPct: 5,
  co2TargetPpm: 900,
  co2VentInterlockThresholdPct: 20,
  vpdTargetKpa: 1,
  dliTargetMol: 17,
  zones: [],
});

const profile = (overrides: Partial<CropProfile> = {}): CropProfile => ({
  id: "lettuce",
  name: "Lettuce",
  crop: "lettuce",
  stages: [{ stage: "vegetative", targets: targets() }],
  ...overrides,
});

describe("ProfileManagement", () => {
  it("lists profiles and surfaces the first stage's targets by default", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.profiles(), [profile()]);
    renderWithProviders(<ProfileManagement />, { client });

    // The name shows in the library list (and, once auto-selected, the detail header).
    expect(screen.getAllByText("Lettuce").length).toBeGreaterThan(0);
    expect(screen.getAllByText("vegetative").length).toBeGreaterThan(0);
    // The first stage is auto-selected and its climate targets are surfaced read-only —
    // data the old card grid only exposed inside the edit dialog.
    expect(screen.getByText("Temp — day")).toBeInTheDocument();
    expect(screen.getByText("CO₂ target")).toBeInTheDocument();
    expect(screen.getByText("DLI target")).toBeInTheDocument();
  });

  it("shows the empty state when the library is empty", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.profiles(), []);
    renderWithProviders(<ProfileManagement />, { client });

    expect(screen.getByText("No crop profiles yet")).toBeInTheDocument();
  });

  it("selects a stage to reveal that stage's targets", () => {
    const flowering: Setpoints = { ...targets(), temperatureDayC: 26, co2TargetPpm: 1100 };
    const client = makeClient();
    client.setQueryData(queryKeys.profiles(), [
      profile({
        stages: [
          { stage: "vegetative", targets: targets() },
          { stage: "flowering", targets: flowering },
        ],
      }),
    ]);
    renderWithProviders(<ProfileManagement />, { client });

    // Default (vegetative) stage: CO₂ target 900 in the targets pane.
    expect(screen.getByText("900")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /flowering/i }));
    // Flowering stage now drives the pane: CO₂ target 1100.
    expect(screen.getByText("1100")).toBeInTheDocument();
  });

  it("renders irrigation zones on the Irrigation tab", () => {
    const withZone: Setpoints = {
      ...targets(),
      zones: [
        {
          zoneId: "zone-1",
          moistureLowThreshold: 0.3,
          moistureHighThreshold: 0.6,
          drainPeriodSecs: 600,
          schedule: "06:00",
        },
      ],
    };
    const client = makeClient();
    client.setQueryData(queryKeys.profiles(), [
      profile({ stages: [{ stage: "vegetative", targets: withZone }] }),
    ]);
    renderWithProviders(<ProfileManagement />, { client });

    fireEvent.click(screen.getByRole("tab", { name: /irrigation/i }));
    expect(screen.getByText("zone-1")).toBeInTheDocument();
  });

  it("filters the library by crop", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.profiles(), [
      profile(),
      profile({ id: "cukes", name: "Cucumbers", crop: "cucumber" }),
    ]);
    renderWithProviders(<ProfileManagement />, { client });

    expect(screen.getByText("Cucumbers")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter by crop"), { target: { value: "cucumber" } });
    expect(screen.queryByText("Lettuce")).not.toBeInTheDocument();
    expect(screen.getAllByText("Cucumbers").length).toBeGreaterThan(0);
  });
});

describe("ProfileEditForm", () => {
  const field = (container: HTMLElement, name: string) =>
    container.querySelector<HTMLInputElement>(`[name="${name}"]`)!;

  it("seeds a crop-safe envelope around each target for a new profile", () => {
    const client = makeClient();
    const { container } = renderWithProviders(<ProfileEditForm onClose={() => {}} />, { client });

    // defaultTargets() day temp is 22 with a ±3 seed margin → [19, 25].
    expect(field(container, "stage-0-temperatureDayC").value).toBe("22");
    expect(field(container, "stage-0-temperatureDayC-min").value).toBe("19");
    expect(field(container, "stage-0-temperatureDayC-max").value).toBe("25");
  });

  it("labels the crop-safe inputs via a single column header, not a per-row label", () => {
    const client = makeClient();
    renderWithProviders(<ProfileEditForm onClose={() => {}} />, { client });

    // The spec-table renders one shared "Target" column header rather than repeating a label per row.
    expect(screen.getAllByText("Target")).toHaveLength(1);
    // Each numeric input is reachable by an accessible (aria) name in place of a visible per-input label.
    expect(
      screen.getByRole("spinbutton", { name: "Day temp (°C) crop-safe min" }),
    ).toBeInTheDocument();
  });

  it("rejects a target that falls outside its crop-safe range before submitting", () => {
    const client = makeClient();
    const { container } = renderWithProviders(<ProfileEditForm onClose={() => {}} />, { client });

    const set = (name: string, value: string) =>
      fireEvent.change(field(container, name), { target: { value } });
    set("profile-id", "lettuce");
    set("profile-name", "Lettuce");
    set("profile-crop", "lettuce");
    // Move the envelope above the (22) target so the target no longer sits inside it.
    set("stage-0-temperatureDayC-min", "30");
    set("stage-0-temperatureDayC-max", "35");

    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    expect(screen.getByRole("alert").textContent).toMatch(/outside its crop-safe range/);
  });
});

describe("ProfileAssignmentPanel", () => {
  it("shows the current assignment and offers the profile/stage selectors", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.profiles(), [profile()]);
    const assignment: Assignment = {
      greenhouseId: "gh-a",
      profileId: "lettuce",
      stage: "vegetative",
    };
    client.setQueryData(queryKeys.assignment("gh-a"), assignment);

    renderWithProviders(<ProfileAssignmentPanel greenhouseId="gh-a" />, { client });

    expect(screen.getByText("lettuce")).toBeInTheDocument();
    expect(screen.getByLabelText("Profile")).toBeInTheDocument();
    expect(screen.getByLabelText("Growth stage")).toBeInTheDocument();
  });

  it("prompts to create a profile when the library is empty", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.profiles(), []);
    // Seed the assignment query so it resolves from cache rather than hitting the network.
    const assignment: Assignment = {
      greenhouseId: "gh-a",
      profileId: "lettuce",
      stage: "vegetative",
    };
    client.setQueryData(queryKeys.assignment("gh-a"), assignment);

    renderWithProviders(<ProfileAssignmentPanel greenhouseId="gh-a" />, { client });

    expect(screen.getByText("Create a crop profile to assign one here.")).toBeInTheDocument();
  });
});
