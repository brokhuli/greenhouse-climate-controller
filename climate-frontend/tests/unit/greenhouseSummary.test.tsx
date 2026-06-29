import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GreenhouseSummaryBar } from "../../src/features/greenhouse/GreenhouseSummaryBar";
import { sampleSetpoints } from "../utils";

describe("GreenhouseSummaryBar", () => {
  it("renders the climate tiles with formatted readings, status, and drift", () => {
    render(
      <GreenhouseSummaryBar
        status="degraded"
        drift
        setpoints={sampleSetpoints()}
        readings={{ temperature: 26.8, humidity: 72, co2: 812, vpd: 1.02 }}
        dli={18.6}
        faultCount={1}
      />,
    );

    for (const label of ["Temperature", "Humidity", "VPD", "CO₂", "DLI", "Status", "Drift"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // The unit is rendered as a separate muted span, so assert on the numeric portion.
    expect(screen.getByText("26.8")).toBeInTheDocument();
    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByText("1.02")).toBeInTheDocument();
    expect(screen.getByText("812")).toBeInTheDocument();
    expect(screen.getByText("18.6")).toBeInTheDocument();

    expect(screen.getByText("Degraded")).toBeInTheDocument();
    expect(screen.getByText("1 active fault")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("Setpoints mismatched")).toBeInTheDocument();
  });

  it("shows an em dash for missing readings and pluralizes the fault count", () => {
    render(
      <GreenhouseSummaryBar
        status="online"
        drift={false}
        setpoints={sampleSetpoints()}
        readings={{}}
        dli={null}
        faultCount={0}
      />,
    );

    // Four house readings + DLI are all unavailable.
    expect(screen.getAllByText("—")).toHaveLength(5);
    expect(screen.getByText("0 active faults")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
    expect(screen.getByText("In sync")).toBeInTheDocument();
  });
});
