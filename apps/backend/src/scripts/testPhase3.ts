import { chromium } from "playwright";
import { detectCandidates } from "../candidates/detectCandidates";
import { Candidate, DeferredControl } from "../candidates/types";
import { ScanConfig } from "../config/scanConfig";
import { checkActionContracts } from "../contracts/actionContracts";
import { ContractResult } from "../contracts/types";
import {
  authenticate,
  discoverPages,
  DiscoveredPage,
} from "../crawl/discoverPages";
import { buildActionTargets } from "../discovery/actionTargets";
import { classifyControl } from "../discovery/classifyControl";
import { ActionObservation, executeAction } from "../discovery/executeAction";
import { cleanUpOwnRecords } from "../entity/cleanup";
import { ClassifiedAction } from "../discovery/types";
import { createLlmClient } from "../llm/createLlmClient";
import { settleStats } from "../execution/network";

/**
 * Manual end-to-end check for Phase 3: crawl → detect → classify the
 * standalone controls with the LLM (Semantic Contract Discovery) → execute
 * the data-changing ones on records the tester creates itself → Contract
 * Check. Phase 2's form candidates are detected (they are needed to create
 * records) but not executed here; run testPhase2.ts for those.
 *
 * What to look for when pointed at TaskFlow:
 * - B3 → NoServerError VIOLATION on "Mark complete" (500 from the server).
 * - I4 → ConfirmBeforeDestructive VIOLATION (discovered) on "Delete task".
 * - T3 → DeletionEffective SATISFIED, with the 404 after deletion listed
 *        as the correct response — not as an error.
 * - T1 → nothing: the engine never looks at colours.
 * - The seeded task 1 is never modified: every action runs on a task the
 *   tester created, whose title contains "AI Tester sample".
 *
 * Needs Ollama running with the model pulled (default qwen3:4b).
 * Run from apps/backend with: pnpm exec tsx src/scripts/testPhase3.ts
 * Env: BASE_URL, START_PATH, TEST_USERNAME, TEST_PASSWORD,
 *      LLM_PROVIDER (ollama | none), LLM_MODEL, OLLAMA_URL, LLM_CACHE=off
 */
const config: ScanConfig = {
  baseUrl: process.env.BASE_URL ?? "http://localhost:5173",
  startPath: process.env.START_PATH ?? "/",
  credentials: {
    username: process.env.TEST_USERNAME ?? "demo@taskflow.test",
    password: process.env.TEST_PASSWORD ?? "password123",
  },
  maxPagesPerSession: 12,
};

async function main() {
  const llm = createLlmClient();
  const browser = await chromium.launch();
  const startedAt = Date.now();

  try {
    console.log(`Scanning ${config.baseUrl}`);
    console.log(`LLM: ${llm ? llm.name : "none"}\n`);

    const anonymous = await discoverPages(browser, config, "anonymous");
    const authOutcome = await authenticate(browser, config, anonymous.pages);
    const auth = authOutcome.result;
    const authenticated = auth
      ? await discoverPages(
          browser,
          config,
          "authenticated",
          auth.storageState,
          [auth.landedOn, config.startPath ?? "/"],
        )
      : { pages: [], failures: [] };
    console.log(
      `Pages: ${[...anonymous.pages, ...authenticated.pages].map((p) => p.graph.route).join(", ")}`,
    );
    if (!auth)
      authOutcome.failures.forEach((f) =>
        console.log(`    ! not logged in: ${f}`),
      );

    const { candidates, deferred } = collect([
      ...anonymous.pages,
      ...authenticated.pages,
    ]);
    const targets = buildActionTargets(deferred);
    console.log(`${targets.length} standalone controls to classify\n`);

    const results: ContractResult[] = [];
    const observations: ActionObservation[] = [];
    for (const target of targets) {
      const classified = await classifyControl(llm, target);
      printClassification(classified);

      const observation = await executeAction(
        browser,
        config,
        classified,
        candidates,
        target.control.session === "authenticated"
          ? auth?.storageState
          : undefined,
      );
      observations.push(observation);
      if (observation.instance) {
        console.log(
          `    own record: ${observation.instance.path} (created via ${observation.instance.createdBy})`,
        );
      }

      const actionResults = checkActionContracts(observation);
      results.push(...actionResults);
      for (const r of actionResults) {
        const tag = r.source === "discovered" ? " (discovered)" : "";
        console.log(`    ${r.verdict.padEnd(14)} ${r.contract}${tag}`);
        for (const line of r.evidence) console.log(`        - ${line}`);
      }
      console.log();
    }

    const cleanup = await cleanUpOwnRecords(
      browser,
      config,
      observations,
      auth?.storageState,
    );
    if (cleanup.length) {
      console.log("Cleaning up own records:");
      for (const c of cleanup)
        console.log(
          `    ${c.removed ? "removed" : "kept   "} ${c.instance.path} — ${c.note}`,
        );
      console.log();
    }

    const count = (v: ContractResult["verdict"]) =>
      results.filter((r) => r.verdict === v).length;
    const stats = llm?.stats();
    console.log("=== Summary ===");
    console.log(
      `VIOLATION: ${count("VIOLATION")}   AMBIGUOUS: ${count("AMBIGUOUS")}   SATISFIED: ${count("SATISFIED")}   NOT_APPLICABLE: ${count("NOT_APPLICABLE")}`,
    );
    console.log(
      `Scan time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s   ` +
        `LLM calls: ${stats?.calls ?? 0}   answered from cache: ${stats?.cacheHits ?? 0}`,
    );
    console.log(
      `Waiting for the network: ${(settleStats.totalWaitMs / 1000).toFixed(1)}s over ${settleStats.settles} waits, ` +
        `${settleStats.timeouts} of which hit the timeout`,
    );
  } finally {
    await browser.close();
  }
}

function collect(pages: DiscoveredPage[]): {
  candidates: Candidate[];
  deferred: DeferredControl[];
} {
  const candidates: Candidate[] = [];
  const deferred: DeferredControl[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const detected = detectCandidates(page.graph, page.session);
    for (const c of detected.candidates) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      candidates.push(c);
    }
    deferred.push(...detected.deferred);
  }
  return { candidates, deferred };
}

function printClassification(action: ClassifiedAction) {
  console.log(
    `▸ ${action.routePattern}  ${action.control.role} "${action.control.label}"  [${action.control.session}]`,
  );
  if (action.contract) {
    const c = action.contract;
    console.log(
      `    discovered: ${c.category}${c.requiresConfirmation ? ", expects confirmation" : ""} — ${c.expectation}`,
    );
  } else {
    console.log(`    not classified: ${action.classificationError}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
