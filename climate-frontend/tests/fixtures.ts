import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load the committed contract example fixtures so the SPA's Zod schemas are checked against the
 * exact same instances the contract harness validates (platform-dashboard-rest/ + platform-dashboard-live-ws/ examples).
 */
const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(here, "../../contracts");

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

export const restFixture = (name: string): unknown =>
  readJson(resolve(contractsDir, "platform-dashboard-rest/examples", name));

export const wsFixture = (name: string): unknown =>
  readJson(resolve(contractsDir, "platform-dashboard-live-ws/examples", name));
