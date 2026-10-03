import { chromium } from "playwright";
import { detectCandidates } from "../candidates/detectCandidates";
import { Candidate, DeferredControl } from "../candidates/types";
import { ScanConfig } from "../config/scanConfig";
import { checkActionContracts } from "../contracts/actionContracts";
import { checkContracts } from "../contracts/checkContracts";
import {
  authenticate,
  DiscoveredPage,
  discoverPages,
} from "../crawl/discoverPages";
import { buildActionTargets } from "../discovery/actionTargets";
import { classifyControl } from "../discovery/classifyControl";
import { ActionObservation, executeAction } from "../discovery/executeAction";
import { cleanUpOwnRecords, CleanupResult } from "../entity/cleanup";
import { executeCandidate } from "../execution/executeCandidate";
import { settleStats } from "../execution/network";
import { assignLevel } from "../findings/evidenceLadder";
import { groupFindings } from "../findings/group";
import { isExecutionFailure, judge } from "../findings/judge";
import { reproduce, RunContext } from "../findings/reproduce";
import { CheckedResult, Finding, subjectId } from "../findings/types";
import { auditAccessibility } from "../heuristics/accessibility";
import { checkListScaling } from "../heuristics/listScaling";
import { checkStatusMessages } from "../heuristics/statusMessages";
import { LlmClient } from "../llm/types";

export interface NotChecked {
  subject: string;
  reason: string;
}

export interface ScanStats {
  pages: string[];
  formCandidates: number;
  actions: number;
  reruns: number;
  llmCalls: number;
  llmCacheHits: number;
  durationMs: number;
  networkWaitMs: number;
}

export interface ScanReport {
  baseUrl: string;
  llm: string;
  findings: Finding[];
  discarded: Finding[];
  notChecked: NotChecked[];
  cleanup: CleanupResult[];
  stats: ScanStats;
}

export interface ScanOptions {
  onProgress?: (message: string) => void;
}

/** The whole pipeline: crawl → detect → execute → contracts → judge → group → reproduce → heuristics → Evidence Ladder. */
export async function runScan(
  config: ScanConfig,
  llm: LlmClient | undefined,
  options: ScanOptions = {},
): Promise<ScanReport> {
  const log = options.onProgress ?? (() => {});
  const startedAt = Date.now();
  const waitAtStart = settleStats.totalWaitMs;
  const browser = await chromium.launch();

  try {
    log("Crawling");
    const anonymous = await discoverPages(browser, config, "anonymous");
    const auth = (await authenticate(browser, config, anonymous.pages)).result;
    const authenticated = auth
      ? await discoverPages(
          browser,
          config,
          "authenticated",
          auth.storageState,
          [auth.landedOn, config.startPath ?? "/"],
        )
      : { pages: [], failures: [] };
    const pages = [...anonymous.pages, ...authenticated.pages];
    const { candidates, deferred } = collect(pages);
    const ctx: RunContext = {
      browser,
      config,
      candidates,
      storageState: auth?.storageState,
    };

    const checked: CheckedResult[] = [];
    const notChecked: NotChecked[] = [];
    const actionObservations: ActionObservation[] = [];

    log(`Running ${candidates.length} form interactions`);
    for (const candidate of candidates) {
      const storage =
        candidate.session === "authenticated" ? auth?.storageState : undefined;
      const observation = await executeCandidate(
        browser,
        config,
        candidate,
        storage,
      );
      for (const result of checkContracts(observation))
        checked.push({ result, subject: { kind: "form", candidate } });
    }

    const targets = buildActionTargets(deferred);
    log(`Classifying and running ${targets.length} standalone actions`);
    for (const target of targets) {
      const action = await classifyControl(llm, target);
      const storage =
        target.control.session === "authenticated"
          ? auth?.storageState
          : undefined;
      const observation = await executeAction(
        browser,
        config,
        action,
        candidates,
        storage,
      );
      actionObservations.push(observation);
      for (const result of checkActionContracts(observation))
        checked.push({ result, subject: { kind: "action", action } });
    }

    log("Judging ambiguous outcomes");
    for (const c of checked) {
      if (c.result.verdict === "NOT_APPLICABLE") {
        if (c.subject.kind === "action")
          notChecked.push({
            subject: subjectId(c.subject),
            reason: c.result.evidence[0],
          });
        continue;
      }
      if (c.result.verdict !== "AMBIGUOUS") continue;
      if (isExecutionFailure(c.result)) {
        notChecked.push({
          subject: `${subjectId(c.subject)} [${c.result.contract}]`,
          reason: c.result.evidence[0],
        });
        continue;
      }
      c.judgment = await judge(llm, c);
      if (!c.judgment)
        notChecked.push({
          subject: `${subjectId(c.subject)} [${c.result.contract}]`,
          reason: "ambiguous, and no model judgment was available",
        });
    }

    const findings = groupFindings(checked);
    log(`Reproducing ${findings.length} findings`);
    for (const finding of findings) {
      const rerun = await reproduce(ctx, finding);
      finding.reproduced = rerun.reproduced;
      finding.evidence.push(rerun.note);
      if (rerun.actionObservation)
        actionObservations.push(rerun.actionObservation);
      assignLevel(finding);
    }

    log("Running UX heuristics");
    const scaling = await checkListScaling(ctx, pages);
    scaling.notes.forEach((reason) =>
      notChecked.push({ subject: "list scaling", reason }),
    );
    const heuristicFindings = [
      ...(await auditAccessibility(ctx, pages)),
      ...checkStatusMessages(checked),
      ...scaling.findings,
    ];
    heuristicFindings.forEach(assignLevel);
    findings.push(...heuristicFindings);

    log("Cleaning up own records");
    const cleanup = await cleanUpOwnRecords(
      browser,
      config,
      actionObservations,
      auth?.storageState,
      scaling.created,
    );

    const byLevel = (a: Finding, b: Finding) =>
      b.level - a.level || a.title.localeCompare(b.title);
    const stats = llm?.stats();
    return {
      baseUrl: config.baseUrl,
      llm: llm?.name ?? "none",
      findings: findings.filter((f) => f.level > 0).sort(byLevel),
      discarded: findings.filter((f) => f.level === 0),
      notChecked,
      cleanup,
      stats: {
        pages: pages.map((p) => p.graph.route),
        formCandidates: candidates.length,
        actions: targets.length,
        reruns: findings.length - heuristicFindings.length,
        llmCalls: stats?.calls ?? 0,
        llmCacheHits: stats?.cacheHits ?? 0,
        durationMs: Date.now() - startedAt,
        networkWaitMs: settleStats.totalWaitMs - waitAtStart,
      },
    };
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
