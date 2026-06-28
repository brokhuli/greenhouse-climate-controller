import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import {
  StackedTimeSeriesChart,
  type StackedBand,
} from "../../src/components/ui/StackedTimeSeriesChart";
import { renderWithProviders } from "../utils";

const bands: StackedBand[] = [
  {
    key: "temperature",
    label: "Temperature",
    unit: "°C",
    color: "var(--chart-temperature)",
    points: [
      { t: 1, v: 24 },
      { t: 2, v: 25 },
    ],
    references: [{ label: "Day", value: 24 }],
  },
  {
    key: "humidity",
    label: "Humidity",
    unit: "%RH",
    color: "var(--chart-humidity)",
    points: [
      { t: 1, v: 60 },
      { t: 2, v: 62 },
    ],
  },
];

describe("StackedTimeSeriesChart", () => {
  it("names every band with its latest value in the canvas-free fallback", () => {
    renderWithProviders(<StackedTimeSeriesChart bands={bands} />);
    // jsdom has no 2D canvas, so the chart degrades to its text summary.
    const summary = screen.getByTestId("chart-fallback");
    expect(summary).toHaveTextContent("Temperature: latest 25 °C");
    expect(summary).toHaveTextContent("Humidity: latest 62 %RH");
    // The same summary is the chart's accessible name — keeps the e2e img-name contract.
    const label = screen.getByRole("img").getAttribute("aria-label") ?? "";
    expect(label).toContain("Temperature: latest 25 °C");
    expect(label).toContain("Humidity: latest 62 %RH");
  });

  it("renders a legend entry per band plus the setpoint key", () => {
    renderWithProviders(<StackedTimeSeriesChart bands={bands} />);
    expect(screen.getByText("Temperature (°C)")).toBeInTheDocument();
    expect(screen.getByText("Humidity (%RH)")).toBeInTheDocument();
    expect(screen.getByText("Setpoint / Target")).toBeInTheDocument();
  });
});
