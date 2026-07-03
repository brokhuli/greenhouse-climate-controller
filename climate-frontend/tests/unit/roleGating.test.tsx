import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { SetpointEditForm } from "../../src/features/greenhouse/SetpointEditForm";
import ProfileManagement from "../../src/features/profiles/ProfileManagement";
import { renderWithProviders, sampleSetpoints } from "../utils";

describe("role gating", () => {
  it("renders the setpoint form read-only for a viewer", () => {
    renderWithProviders(
      <SetpointEditForm greenhouseId="gh-a" setpoints={sampleSetpoints()} offline={false} />,
      { role: "viewer" },
    );
    expect(screen.getByText(/operator role is required/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review & apply/i })).toBeDisabled();
  });

  it("enables the setpoint form for an operator", () => {
    renderWithProviders(
      <SetpointEditForm greenhouseId="gh-a" setpoints={sampleSetpoints()} offline={false} />,
      { role: "operator" },
    );
    expect(screen.queryByText(/operator role is required/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review & apply/i })).toBeEnabled();
  });

  it("disables profile creation for a viewer and enables it for an operator", () => {
    const viewer = renderWithProviders(<ProfileManagement />, { role: "viewer" });
    expect(viewer.getByRole("button", { name: /new profile/i })).toBeDisabled();
    viewer.unmount();

    renderWithProviders(<ProfileManagement />, { role: "operator" });
    expect(screen.getByRole("button", { name: /new profile/i })).toBeEnabled();
  });
});
