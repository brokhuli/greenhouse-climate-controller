import { expect, test } from "@playwright/test";

/**
 * Smoke E2E over the real stack: the fleet lists greenhouses, and a greenhouse's detail view
 * actually renders (charts + setpoint editor) rather than the "couldn't load" error card. The
 * detail test guards the schema-parse failure mode a status-only check misses.
 */
test("fleet overview lists the registered greenhouses", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Fleet overview" })).toBeVisible();
  await expect(page.getByText("Greenhouse a")).toBeVisible();
});

test("greenhouse detail renders charts and the setpoint editor (not an error card)", async ({
  page,
}) => {
  await page.goto("/greenhouses/gh-a");

  // The failure mode we're guarding: a 200 whose body fails the SPA's Zod schema surfaces here.
  await expect(page.getByText("Couldn't load this greenhouse")).toHaveCount(0);

  // The detail actually rendered: the setpoint editor panel and at least one metric chart.
  await expect(page.getByRole("heading", { name: "Setpoints" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Temperature/ })).toBeVisible();
});
