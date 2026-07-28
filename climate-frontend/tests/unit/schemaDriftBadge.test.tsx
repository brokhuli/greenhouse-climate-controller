import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SchemaDriftBadge } from "../../src/components/SchemaDriftBadge";

describe("SchemaDriftBadge", () => {
  it("renders nothing while the stream is accepting every frame", () => {
    const { container } = render(
      <SchemaDriftBadge drift={{ count: 0, lastType: null, lastIssue: null }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names the drifted frame type once a known frame is rejected", () => {
    render(
      <SchemaDriftBadge
        drift={{
          count: 3,
          lastType: "telemetry",
          lastIssue: 'unit "ppm" does not match metric "temperature"',
        }}
      />,
    );
    const badge = screen.getByRole("status");
    expect(badge).toHaveTextContent(/schema mismatch/i);
    expect(badge).toHaveTextContent(/telemetry/);
    // The offending Zod issue rides the tooltip so the freeze is diagnosable at a glance.
    expect(badge).toHaveAttribute("title", 'unit "ppm" does not match metric "temperature"');
  });
});
