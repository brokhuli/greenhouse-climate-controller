import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { SetpointEditForm } from "../../src/features/greenhouse/SetpointEditForm";
import { renderWithProviders, sampleSetpoints } from "../utils";

const submitVia = (labelText: string) =>
  fireEvent.submit(screen.getByLabelText(labelText).closest("form") as HTMLFormElement);

describe("SetpointEditForm", () => {
  it("disables editing when the controller is offline", () => {
    renderWithProviders(
      <SetpointEditForm greenhouseId="gh-a" setpoints={sampleSetpoints()} offline />,
    );
    expect(screen.getByText(/controller offline/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review & apply/i })).toBeDisabled();
  });

  it("blocks an invalid cross-field edit and keeps the confirmation closed", async () => {
    renderWithProviders(
      <SetpointEditForm greenhouseId="gh-a" setpoints={sampleSetpoints()} offline={false} />,
    );
    fireEvent.change(screen.getByLabelText("Day end"), { target: { value: "05:00" } });
    submitVia("Day end");

    expect(await screen.findByText(/day end must be after day start/i)).toBeInTheDocument();
    expect(screen.queryByText("Apply setpoint changes?")).not.toBeInTheDocument();
  });

  it("opens a confirmation summarizing the change on a valid edit", async () => {
    renderWithProviders(
      <SetpointEditForm greenhouseId="gh-a" setpoints={sampleSetpoints()} offline={false} />,
    );
    fireEvent.change(screen.getByLabelText("Day temperature (°C)"), { target: { value: "26" } });
    submitVia("Day temperature (°C)");

    expect(await screen.findByText("Apply setpoint changes?")).toBeInTheDocument();
    expect(screen.getByText("24")).toBeInTheDocument(); // from
    expect(screen.getByText("26")).toBeInTheDocument(); // to
  });
});
