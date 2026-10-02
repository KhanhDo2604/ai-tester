import { chromium } from "playwright";
import { buildUISemanticGraph } from "../graph/buildGraph.js";

/**
 * Manual smoke test for Phase 1 (see the project build checklist). Run
 * against two different TaskFlow pages to confirm buildUISemanticGraph
 * produces a sensible, consistent graph on both, with no page-specific code.
 *
 * Adjust BASE_URL and the login step below if your setup differs.
 *
 * Run from apps/backend with: npx tsx src/scripts/testPhase1.ts
 * (or your project's equivalent ts-runner command)
 */
async function main() {
  const BASE_URL = "http://localhost:5173";

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Page 1: the login page — no auth needed to reach this one.
  await page.goto(`${BASE_URL}/login`);
  const loginGraph = await buildUISemanticGraph(page);
  console.log("=== Login page graph ===");
  console.dir(loginGraph, { depth: null });

  // Log in so the create-task page is reachable.
  await page.getByLabel("Email").fill("demo@taskflow.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Log in" }).click();

  await page.waitForURL("**/tasks");

  // Page 2: the create-task page — structurally different (has a form).
  await page.goto(`${BASE_URL}/tasks/new`);
  const createTaskGraph = await buildUISemanticGraph(page);
  console.log("=== Create-task page graph ===");
  console.dir(createTaskGraph, { depth: null });

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
