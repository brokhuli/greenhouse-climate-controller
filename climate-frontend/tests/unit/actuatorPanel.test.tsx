import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ActuatorStatePanel,
  type ActuatorReading,
} from "../../src/features/greenhouse/ActuatorStatePanel";

describe("ActuatorStatePanel", () => {
  it("renders each actuator's name, commanded %, and an On/Off pill from commanded > 0", () => {
    const readings: ActuatorReading[] = [
      { actuator: "heater", commanded: 20, observed: 18 },
      { actuator: "shade_screen", commanded: 0, observed: null },
    ];
    render(<ActuatorStatePanel actuators={readings} />);

    expect(screen.getByText("Heater")).toBeInTheDocument();
    expect(screen.getByText("Shade screen")).toBeInTheDocument();
    // Percentage and unit render together in one node.
    expect(screen.getByText("20 %")).toBeInTheDocument();
    expect(screen.getByText("0 %")).toBeInTheDocument();
    // commanded > 0 → On; commanded === 0 → Off.
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
  });

  it("shows the empty state when there is no actuator data", () => {
    render(<ActuatorStatePanel actuators={[]} />);
    expect(screen.getByText("No actuator data in range.")).toBeInTheDocument();
  });
});
