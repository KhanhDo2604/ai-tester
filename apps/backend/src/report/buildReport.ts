import { createHash } from "crypto";
import { LEVEL_LABELS } from "../findings/evidenceLadder";
import { Finding } from "../findings/types";
import { LOGGED_IN_AREA, ScanReport } from "../scan/runScan";
import { describe } from "./describe";
import { toMarkdown } from "./markdown";
import { suppressionsFor } from "./suppressions";
import { Report, ReportItem } from "./types";

export function itemId(key: string): string {
  return createHash("sha1").update(key).digest("hex").slice(0, 10);
}

/** Identical evidence lines can come from merged results; "×N" lines already carry their count. */
function dedupe(lines: string[]): string[] {
  return [...new Set(lines)];
}

export function toItem(f: Finding, target: string): ReportItem {
  const d = describe(f);
  const item: Omit<ReportItem, "markdown"> = {
    id: itemId(f.key),
    key: f.key,
    kind: f.kind,
    level: f.level,
    levelLabel: LEVEL_LABELS[f.level],
    title: f.title,
    summary: d.summary,
    route: f.route,
    steps: d.steps,
    expected: d.expected,
    actual: d.actual,
    whyLevel: f.levelReason,
    standard: f.standard,
    source: f.source,
    aiConfidence: f.aiConfidence,
    evidence: dedupe(f.evidence),
  };
  return { ...item, markdown: toMarkdown(item, target) };
}

export function buildReport(id: string, scan: ScanReport): Report {
  const items = scan.findings.map((f) => toItem(f, scan.baseUrl));

  return applySuppressions({
    id,
    target: scan.baseUrl,
    llm: scan.llm,
    finishedAt: new Date().toISOString(),
    summary: {
      confirmedBugs: 0,
      potentialIssues: 0,
      improvements: 0,
      suppressed: 0,
      discarded: scan.discarded.length,
    },
    coverage: {
      pages: scan.stats.pages,
      formInteractions: scan.stats.formCandidates,
      actions: scan.stats.actions,
      reruns: scan.stats.reruns,
      llmCalls: scan.stats.llmCalls,
      llmCacheHits: scan.stats.llmCacheHits,
      durationMs: scan.stats.durationMs,
      networkWaitMs: scan.stats.networkWaitMs,
    },
    bugs: items.filter((i) => i.kind === "bug"),
    improvements: items.filter((i) => i.kind === "improvement"),
    suppressed: [],
    discarded: scan.discarded.map((f) => toItem(f, scan.baseUrl)),
    warnings: warningsFor(scan),
    notChecked: scan.notChecked,
    cleanup: scan.cleanup.map((c) => ({
      path: c.instance.path,
      removed: c.removed,
      note: c.note,
    })),
  });
}

/** Skips caused by a failure (not by a deliberate rule) mean the report may be missing findings. */
function warningsFor(scan: ScanReport): string[] {
  const warnings = scan.notChecked
    .filter((n) => /not classified: (?!no LLM)/.test(n.reason))
    .map((n) => {
      const [route, label] = n.subject.split(" :: ");
      return `"${label ?? route}"${label ? ` on ${route}` : ""} was not tested because the AI model failed to answer. Re-running the scan usually fixes this.`;
    });
  for (const n of scan.notChecked.filter((n) => n.subject === LOGGED_IN_AREA)) {
    warnings.push(
      `Only pages visible without logging in were tested: ${n.reason}.`,
    );
  }
  if (scan.llm === "none")
    warnings.push(
      "No AI model was configured, so standalone buttons were not tested.",
    );
  const kept = scan.cleanup.filter((c) => !c.removed);
  if (kept.length)
    warnings.push(
      `Data the tester created was left in the app: ${kept.map((c) => `${c.instance.path} (${c.note})`).join(", ")}.`,
    );
  return warnings;
}

/** Re-applies current suppressions to a stored report, so marking a finding updates the view without rescanning. */
export function applySuppressions(report: Report): Report {
  const suppressions = suppressionsFor(report.target);
  const all = [
    ...report.bugs,
    ...report.improvements,
    ...report.suppressed,
  ].map((i) => ({ ...i, suppression: undefined }));
  const active = all.filter((i) => !suppressions[i.key]);
  const suppressed = all
    .filter((i) => suppressions[i.key])
    .map((i) => ({ ...i, suppression: suppressions[i.key] }));
  const byLevel = (a: ReportItem, b: ReportItem) =>
    b.level - a.level || a.title.localeCompare(b.title);
  const bugs = active.filter((i) => i.kind === "bug").sort(byLevel);
  const improvements = active
    .filter((i) => i.kind === "improvement")
    .sort(byLevel);

  return {
    ...report,
    bugs,
    improvements,
    suppressed,
    summary: {
      ...report.summary,
      confirmedBugs: bugs.filter((i) => i.level >= 3).length,
      potentialIssues: bugs.filter((i) => i.level === 2).length,
      improvements: improvements.length,
      suppressed: suppressed.length,
    },
  };
}
