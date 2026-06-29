import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import GreenhouseDetail from "../../src/features/greenhouse/GreenhouseDetail";
import { queryKeys } from "../../src/api/queries/keys";
import {
  makeClient,
  renderWithProviders,
  sampleDetail,
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
  });
});
