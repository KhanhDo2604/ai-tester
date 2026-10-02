import { chromium } from "playwright";
import { detectCandidates } from "../candidates/detectCandidates";
import { Candidate, DeferredControl } from "../candidates/types";
import { ScanConfig } from "../config/scanConfig";
import { checkContracts } from "../contracts/checkContracts";
import { ContractResult } from "../contracts/types";
import {
  authenticate,
  CrawlFailure,
  discoverPages,
  DiscoveredPage,
} from "../crawl/discoverPages";
import { executeCandidate } from "../execution/executeCandidate";

/**
 * Manual end-to-end check for Phase 2: crawl → detect candidates →
 * execute → Contract Check. Nothing below knows which app it is pointed
 * at; the target is defined only by the config.
 *
 * What to look for when pointed at TaskFlow:
 * - B1 → StateConsistency VIOLATION on the login form's validSubmit
 *        (navigation right after login differs from a fresh load).
 * - T4 → FormValidationFeedback SATISFIED on /tasks/new
 *        (submit disabled while Title is empty), NOT a violation.
 * - T5 → no VIOLATION on the sign-up form's validSubmit, even though the
 *        new account lands on an empty task list.
 * - B2 → FormatValidation VIOLATION on the sign-up form's invalidFormat
 *        (malformed email accepted).
 * - B4 → FormValidationFeedback / ActionFeedback VIOLATION on the
 *        "Add comment" adjacent group (the button does nothing).
 * - T2 → no invalidFormat candidate on the profile form, because its
 *        email field is disabled.
 * - B3 and T3 → not reachable in Phase 2: "Mark complete" is a
 *        standalone action, executed only once Phase 3 exists.
 *
 * Run from apps/backend with: pnpm exec tsx src/scripts/testPhase2.ts
 * Override the target with env vars BASE_URL, START_PATH, TEST_USERNAME, TEST_PASSWORD.
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
  const browser = await chromium.launch();
  const startedAt = Date.now();

  try {
    console.log(`Scanning ${config.baseUrl}\n`);

    const anonymous = await discoverPages(browser, config, "anonymous");
    console.log(
      `Anonymous pages: ${anonymous.pages.map((p) => p.graph.route).join(", ") || "(none)"}`,
    );
    printFailures(anonymous.failures);

    const authOutcome = await authenticate(browser, config, anonymous.pages);
    const auth = authOutcome.result;
    const storageState = auth?.storageState;
    if (auth) {
      console.log(
        `Logged in with the test account (landed on ${auth.landedOn}).`,
      );
    } else {
      console.log("Not logged in:");
      for (const reason of authOutcome.failures) console.log(`    ! ${reason}`);
    }

    const authenticated = auth
      ? await discoverPages(
          browser,
          config,
          "authenticated",
          auth.storageState,
          [auth.landedOn, config.startPath ?? "/"],
        )
      : { pages: [], failures: [] };
    if (auth) {
      console.log(
        `Authenticated pages: ${authenticated.pages.map((p) => p.graph.route).join(", ") || "(none)"}`,
      );
      printFailures(authenticated.failures);
    }

    const { candidates, deferred } = collectCandidates([
      ...anonymous.pages,
      ...authenticated.pages,
    ]);
    console.log(
      `\n${candidates.length} candidates, ${deferred.length} deferred controls\n`,
    );

    const results: ContractResult[] = [];
    for (const candidate of candidates) {
      const observation = await executeCandidate(
        browser,
        config,
        candidate,
        candidate.session === "authenticated" ? storageState : undefined,
      );
      const candidateResults = checkContracts(observation);
      results.push(...candidateResults);
      printCandidate(candidate, candidateResults);
    }

    printDeferred(deferred);
    printSummary(results, Date.now() - startedAt);
  } finally {
    await browser.close();
  }
}

/**
 * Detects candidates on every page. The same form can be reachable in
 * both sessions (e.g. a login page that doesn't redirect logged-in
 * users); the anonymous one is kept since pages are listed anonymous-first.
 */
function collectCandidates(pages: DiscoveredPage[]) {
  const candidates: Candidate[] = [];
  const deferred: DeferredControl[] = [];
  const seenCandidates = new Set<string>();
  const seenDeferred = new Set<string>();

  for (const page of pages) {
    const detected = detectCandidates(page.graph, page.session);
    for (const c of detected.candidates) {
      if (seenCandidates.has(c.id)) continue;
      seenCandidates.add(c.id);
      candidates.push(c);
    }
    for (const d of detected.deferred) {
      // A control in the navigation repeats on every page; list it once.
      const key =
        d.region === "persistent"
          ? `persistent::${d.role}::${d.label}`
          : `${d.route}::${d.role}::${d.label}`;
      if (seenDeferred.has(key)) continue;
      seenDeferred.add(key);
      deferred.push(d);
    }
  }

  return { candidates, deferred };
}

function printFailures(failures: CrawlFailure[]) {
  for (const f of failures)
    console.log(`    ! could not open ${f.path} [${f.session}]: ${f.error}`);
}

function printCandidate(candidate: Candidate, results: ContractResult[]) {
  console.log(
    `▸ ${candidate.route}  ${candidate.grouping} "${candidate.formName}"  ${candidate.strategy}` +
      `${candidate.submitMode === "enter" ? " (Enter)" : ""}  [${candidate.session}]`,
  );
  for (const r of results) {
    console.log(`    ${r.verdict.padEnd(14)} ${r.contract}`);
    for (const line of r.evidence) console.log(`        - ${line}`);
  }
  console.log();
}

function printDeferred(deferred: DeferredControl[]) {
  if (!deferred.length) return;
  console.log("Deferred to Phase 3 (standalone actions):");
  for (const d of deferred)
    console.log(`    ${d.route}  ${d.role} "${d.label}"  [${d.session}]`);
  console.log();
}

function printSummary(results: ContractResult[], elapsedMs: number) {
  const count = (verdict: ContractResult["verdict"]) =>
    results.filter((r) => r.verdict === verdict).length;
  console.log("=== Summary ===");
  console.log(
    `VIOLATION: ${count("VIOLATION")}   AMBIGUOUS: ${count("AMBIGUOUS")}   SATISFIED: ${count("SATISFIED")}   NOT_APPLICABLE: ${count("NOT_APPLICABLE")}`,
  );
  console.log(`Scan time: ${(elapsedMs / 1000).toFixed(1)}s   LLM calls: 0`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
