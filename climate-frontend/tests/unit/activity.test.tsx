import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import ActivityFeed from "../../src/features/activity/ActivityFeed";
import { queryKeys } from "../../src/api/queries/keys";
import { makeClient, renderWithProviders, sampleEvent } from "../utils";

describe("ActivityFeed", () => {
  it("groups events by severity", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.events({}), [
      sampleEvent({ severity: "critical", kind: "fault", message: "heater fault" }),
      sampleEvent({ severity: "info", message: "setpoint edit applied" }),
    ]);
    renderWithProviders(<ActivityFeed />, { client });

    expect(screen.getByText("heater fault")).toBeInTheDocument();
    expect(screen.getByText("setpoint edit applied")).toBeInTheDocument();
    expect(screen.getByText(/critical \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/info \(1\)/i)).toBeInTheDocument();
  });

  it("renders the kind and severity filter controls", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.events({}), [sampleEvent()]);
    renderWithProviders(<ActivityFeed />, { client });

    expect(screen.getByLabelText("Filter by kind")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by severity")).toBeInTheDocument();
  });
});
