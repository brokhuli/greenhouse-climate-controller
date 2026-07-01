import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import GreenhouseDetail from "../../src/features/greenhouse/GreenhouseDetail";
import { queryKeys } from "../../src/api/queries/keys";
import {
  makeClient,
  renderWithProviders,
  sampleDetail,
  sampleEvent,
  sampleSetpoints,
  sampleSummary,
} from "../utils";

describe("GreenhouseDetail", () => {
  it("links to the setpoint editor instead of rendering the form inline", () => {
    const client = makeClient();
    // No irrigation zones → no soil-moisture uPlot chart, which can't mount in jsdom (the stacked
    // climate chart degrades to its canvas-free text fallback). Keeps this page-level render clean.
    client.setQueryData(
      queryKeys.greenhouse("gh-a"),
      sampleDetail({
        id: "gh-a",
        displayName: "Greenhouse A",
        setpoints: sampleSetpoints({ zones: [] }),
      }),
    );
    client.setQueryData(queryKeys.fleet(), [sampleSummary({ id: "gh-a" })]);
    client.setQueryData(queryKeys.events({ greenhouseId: "gh-a" }), [sampleEvent()]);
    renderWithProviders(
      <Routes>
        <Route path="/greenhouses/:id" element={<GreenhouseDetail />} />
      </Routes>,
      { client, route: "/greenhouses/gh-a" },
    );

    // The CTA into the dedicated editing view sits on the detail toolbar.
    expect(screen.getByRole("button", { name: "Edit Setpoints" })).toBeInTheDocument();
    // The editor moved to its own view — no inline Setpoints panel renders here anymore.
    expect(screen.queryByRole("heading", { name: "Setpoints" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View all activity for Greenhouse A" }),
    ).toHaveAttribute("href", "/activity?greenhouse_id=gh-a");
  });

  it("renders the per-zone soil-moisture status table", () => {
    const client = makeClient();
    // The default detail fixture carries one zone (bench-a) with healthy live status.
    client.setQueryData(queryKeys.greenhouse("gh-a"), sampleDetail({ id: "gh-a" }));
    client.setQueryData(queryKeys.fleet(), [sampleSummary({ id: "gh-a" })]);
    client.setQueryData(queryKeys.events({ greenhouseId: "gh-a" }), [sampleEvent()]);
    renderWithProviders(
      <Routes>
        <Route path="/greenhouses/:id" element={<GreenhouseDetail />} />
      </Routes>,
      { client, route: "/greenhouses/gh-a" },
    );

    expect(screen.getByText("Bench A")).toBeInTheDocument(); // slug prettified
    expect(screen.getByText("41 %")).toBeInTheDocument(); // snapshot moisture
    expect(screen.getByText(/30\s*[–-]\s*60\s*%/)).toBeInTheDocument(); // target range
    expect(screen.getByText("OK")).toBeInTheDocument(); // in-band status
    expect(screen.getByText(/Irrigation Schedule/)).toBeInTheDocument();
  });

  it("shows only the 12 most recent activity rows", () => {
    const client = makeClient();
    client.setQueryData(queryKeys.greenhouse("gh-a"), sampleDetail({ id: "gh-a" }));
    client.setQueryData(queryKeys.fleet(), [sampleSummary({ id: "gh-a" })]);
    client.setQueryData(
      queryKeys.events({ greenhouseId: "gh-a" }),
      Array.from({ length: 13 }, (_value, index) =>
        sampleEvent({
          message: `activity ${index + 1}`,
          ts: new Date(Date.UTC(2026, 5, 29, 14, 13 - index, 0)),
        }),
      ),
    );

    renderWithProviders(
      <Routes>
        <Route path="/greenhouses/:id" element={<GreenhouseDetail />} />
      </Routes>,
      { client, route: "/greenhouses/gh-a" },
    );

    expect(screen.getByText("activity 1")).toBeInTheDocument();
    expect(screen.getByText("activity 12")).toBeInTheDocument();
    expect(screen.queryByText("activity 13")).not.toBeInTheDocument();
  });
});
