import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import ProfileManagement from "../../src/features/profiles/ProfileManagement";
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
  it("lists profiles from the library", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.profiles(), [profile()]);
    renderWithProviders(<ProfileManagement />, { client });

    expect(screen.getByText("Lettuce")).toBeInTheDocument();
    expect(screen.getByText("vegetative")).toBeInTheDocument();
  });

  it("shows the empty state when the library is empty", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.profiles(), []);
    renderWithProviders(<ProfileManagement />, { client });

    expect(screen.getByText("No crop profiles yet")).toBeInTheDocument();
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
