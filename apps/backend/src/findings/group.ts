import { ContractName } from "../candidates/types";
import {
  CheckedResult,
  Finding,
  subjectName,
  subjectRoute,
  toPattern,
} from "./types";

/** Contracts whose violation is a symptom ("nothing visible happened") rather than a cause. */
const NO_FEEDBACK: ContractName[] = [
  "FormValidationFeedback",
  "ActionFeedback",
  "ActionEffect",
];

const SERVER_FAILURE = /server failed: (\S+) (\S+) → (\S+)/;

/** A result counts toward a finding if it was violated outright or judged violated. */
export function isProblem(c: CheckedResult): boolean {
  return c.result.verdict === "VIOLATION" || c.judgment?.violated === true;
}

/**
 * Groups problem results into one finding per root cause:
 * - every 5xx on the same endpoint is one finding, and "nothing happened"
 *   symptoms of the same subject attach to it;
 * - otherwise, "nothing happened" results of one subject merge across
 *   strategies (e.g. empty and filled submit of the same dead button);
 * - anything else is keyed by contract and subject.
 */
export function groupFindings(checked: CheckedResult[]): Finding[] {
  const bySubject = new Map<string, CheckedResult[]>();
  for (const c of checked.filter(isProblem)) {
    const id = `${subjectRoute(c.subject)}::${subjectName(c.subject)}`;
    bySubject.set(id, [...(bySubject.get(id) ?? []), c]);
  }

  const groups = new Map<string, CheckedResult[]>();
  const add = (key: string, c: CheckedResult) =>
    groups.set(key, [...(groups.get(key) ?? []), c]);

  for (const results of bySubject.values()) {
    const serverKeys = results.flatMap((c) =>
      c.result.contract === "NoServerError" ? (serverKey(c) ?? []) : [],
    );
    for (const c of results) {
      const { contract } = c.result;
      const where = `${subjectRoute(c.subject)}::${subjectName(c.subject)}`;
      if (contract === "NoServerError")
        add(serverKey(c) ?? `NoServerError::${where}`, c);
      else if (NO_FEEDBACK.includes(contract) && serverKeys.length)
        add(serverKeys[0], c);
      else if (NO_FEEDBACK.includes(contract)) add(`no-feedback::${where}`, c);
      else add(`${contract}::${where}`, c);
    }
  }

  return [...groups.entries()].map(([key, results]) => toFinding(key, results));
}

function serverKey(c: CheckedResult): string | undefined {
  const line = c.result.evidence.find((e) => SERVER_FAILURE.test(e));
  const m = line?.match(SERVER_FAILURE);
  if (!m) return undefined;
  const [, method, url, status] = m;
  return `server::${method} ${toPattern(url.split("?")[0])} ${status}`;
}

/** The representative result (used for steps and the rerun): a valid submit reads most naturally. */
const STRATEGY_ORDER = ["validSubmit", "invalidFormat", "emptySubmit"];
const rank = (c: CheckedResult) =>
  c.subject.kind === "form"
    ? STRATEGY_ORDER.indexOf(c.subject.candidate.strategy)
    : 0;

function toFinding(key: string, unordered: CheckedResult[]): Finding {
  const results = [...unordered].sort((a, b) => rank(a) - rank(b));
  const first = results[0];
  const contracts = [...new Set(results.map((r) => r.result.contract))];
  const source = results.some((r) => r.result.source === "discovered")
    ? "discovered"
    : results.every((r) => r.judgment)
      ? "judged"
      : "predefined";

  const evidence: string[] = [];
  for (const r of results) {
    for (const line of r.result.evidence)
      if (!evidence.includes(line)) evidence.push(line);
    if (r.judgment)
      evidence.push(
        `judged by the model (confidence ${r.judgment.confidence.toFixed(2)}): ${r.judgment.reason}`,
      );
  }

  const judged = results.filter((r) => r.judgment);
  return {
    key,
    title: titleFor(key, first),
    kind: "bug",
    level: 0,
    levelReason: "",
    route: subjectRoute(first.subject),
    contracts,
    source,
    evidence,
    results,
    aiConfidence: judged.length
      ? Math.max(...judged.map((r) => r.judgment!.confidence))
      : undefined,
  };
}

function titleFor(key: string, c: CheckedResult): string {
  const name = subjectName(c.subject);
  const route = subjectRoute(c.subject);
  if (key.startsWith("server::"))
    return `Server error on ${key.slice("server::".length)}`;
  if (key.startsWith("no-feedback::"))
    return `"${name}" on ${route} gives no visible response`;
  switch (c.result.contract) {
    case "StateConsistency":
      return `After "${name}" on ${route}, the page shows outdated state until reloaded`;
    case "FormatValidation":
      return `"${name}" on ${route} accepts a malformed value`;
    case "ConfirmBeforeDestructive":
      return `"${name}" takes effect without confirmation`;
    case "DeletionEffective":
      return `"${name}" does not remove the record`;
    default:
      return `${c.result.contract} problem with "${name}" on ${route}`;
  }
}
