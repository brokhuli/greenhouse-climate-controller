import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TimeScaleControl } from "../../src/components/ui/TimeScaleControl";

describe("TimeScaleControl", () => {
  const STOPS = ["0.5×", "1×", "2×", "4×", "8×"];

  it("renders every operator speed stop up to 8×", () => {
    render(<TimeScaleControl value={1} onChange={() => {}} />);
    for (const label of STOPS) {
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("radio", { name: "16×" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "32×" })).not.toBeInTheDocument();
    // The observed value is the checked radio.
    expect(screen.getByRole("radio", { name: "1×" })).toHaveAttribute("aria-checked", "true");
  });

  it("calls onChange with the selected scale when a stop is clicked", () => {
    const onChange = vi.fn();
    render(<TimeScaleControl value={1} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "8×" }));
    expect(onChange).toHaveBeenCalledWith(8);
  });

  it("disables every stop when the control is disabled", () => {
    render(<TimeScaleControl value={8} onChange={() => {}} disabled />);
    for (const label of STOPS) {
      expect(screen.getByRole("radio", { name: label })).toBeDisabled();
    }
  });
});
