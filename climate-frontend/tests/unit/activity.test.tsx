import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import ActivityFeed from "../../src/features/activity/ActivityFeed";
import { queryKeys } from "../../src/api/queries/keys";
import { makeClient, renderWithProviders, sampleEvent, sampleSummary } from "../utils";

describe("ActivityFeed", () => {
  it("groups events by severity", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.fleet(), [sampleSummary()]);
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
    client.setQueryData(queryKeys.fleet(), [sampleSummary()]);
    client.setQueryData(queryKeys.events({}), [sampleEvent()]);
    renderWithProviders(<ActivityFeed />, { client });

    expect(screen.getByLabelText("Filter by greenhouse")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by kind")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by severity")).toBeInTheDocument();
  });

  it("filters events by the selected greenhouse", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.fleet(), [
      sampleSummary({ id: "gh-a", displayName: "Greenhouse A" }),
      sampleSummary({ id: "gh-b", displayName: "Greenhouse B" }),
    ]);
    client.setQueryData(queryKeys.events({}), [
      sampleEvent({ greenhouseId: "gh-a", message: "greenhouse a event" }),
      sampleEvent({ greenhouseId: "gh-b", message: "greenhouse b event" }),
    ]);
    client.setQueryData(queryKeys.events({ greenhouseId: "gh-b" }), [
      sampleEvent({ greenhouseId: "gh-b", message: "greenhouse b event" }),
    ]);

    renderWithProviders(<ActivityFeed />, { client });
    fireEvent.change(screen.getByLabelText("Filter by greenhouse"), { target: { value: "gh-b" } });

    expect(screen.queryByText("greenhouse a event")).not.toBeInTheDocument();
    expect(screen.getByText("greenhouse b event")).toBeInTheDocument();
  });

  it("opens with the greenhouse from the URL selected", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.fleet(), [
      sampleSummary({ id: "gh-a", displayName: "Greenhouse A" }),
      sampleSummary({ id: "gh-b", displayName: "Greenhouse B" }),
    ]);
    client.setQueryData(queryKeys.events({ greenhouseId: "gh-b" }), [
      sampleEvent({ greenhouseId: "gh-b", message: "greenhouse b event" }),
    ]);

    renderWithProviders(<ActivityFeed />, { client, route: "/activity?greenhouse_id=gh-b" });

    expect(screen.getByLabelText("Filter by greenhouse")).toHaveValue("gh-b");
    expect(screen.getByText("greenhouse b event")).toBeInTheDocument();
  });
});
