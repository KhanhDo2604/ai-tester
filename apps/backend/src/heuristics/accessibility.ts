import AxeBuilder from "@axe-core/playwright";
import { Page } from "playwright";
import { DiscoveredPage } from "../crawl/discoverPages";
import { navigate, openPage } from "../execution/executeCandidate";
import { NetworkTracker } from "../execution/network";
import { RunContext } from "../findings/reproduce";
import { Finding, toPattern } from "../findings/types";

/**
 * WCAG 2.1 A/AA only: the level most accessibility regulations reference.
 * axe "best-practice" and WCAG 2.2 rules are left out to keep noise down.
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

type AxeViolation = Awaited<
  ReturnType<AxeBuilder["analyze"]>
>["violations"][number];

type AxeNode = AxeViolation["nodes"][number];

interface RuleHits {
  violation: AxeViolation;
  cause: string;
  pages: { pattern: string; violation: AxeViolation; reproduced: boolean }[];
}

/**
 * Splits a rule into separate causes where one rule covers unrelated fixes.
 * For contrast, the cause is the colour pair: every element with the same
 * pair is fixed by one CSS change, a different pair by another.
 */
function causeOf(v: AxeViolation, n: AxeNode): string {
  if (v.id !== "color-contrast") return "";
  const data = n.any.find((c) => c.id === "color-contrast")?.data as
    { fgColor?: string; bgColor?: string } | undefined;
  return data?.fgColor && data.bgColor
    ? `${data.fgColor} on ${data.bgColor}`
    : "";
}

function splitByCause(
  violations: AxeViolation[],
): Map<string, { violation: AxeViolation; cause: string }> {
  const out = new Map<string, { violation: AxeViolation; cause: string }>();
  for (const v of violations) {
    for (const n of v.nodes) {
      const cause = causeOf(v, n);
      const key = cause ? `${v.id}::${cause}` : v.id;
      const entry = out.get(key) ?? { violation: { ...v, nodes: [] }, cause };
      entry.violation.nodes.push(n);
      out.set(key, entry);
    }
  }
  return out;
}

async function audit(
  page: Page,
  network: NetworkTracker,
): Promise<AxeViolation[]> {
  await network.settle();
  return (await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze())
    .violations;
}

function successCriteria(tags: string[]): string[] {
  return tags.flatMap((t) => {
    const m = t.match(/^wcag(\d)(\d)(\d+)$/);
    return m ? [`${m[1]}.${m[2]}.${m[3]}`] : [];
  });
}

function describeNodes(
  v: AxeViolation,
  pattern: string,
  limit: number,
): string[] {
  return v.nodes.slice(0, limit).map((n) => {
    const why =
      (n.failureSummary ?? "")
        .split("\n")
        .find((l) => l.trim() && !l.startsWith("Fix")) ?? "";
    return `${pattern} ${n.target.join(" ")}: ${n.html.slice(0, 120)}${why ? ` — ${why.trim()}` : ""}`;
  });
}

/**
 * Runs axe-core on every crawled page shape, twice (load, then reload).
 * One finding per rule and cause for the whole app, since a rule failing on
 * many pages is usually one shared cause (a layout, a component).
 */
export async function auditAccessibility(
  ctx: RunContext,
  pages: DiscoveredPage[],
): Promise<Finding[]> {
  const rules = new Map<string, RuleHits>();

  for (const discovered of pages) {
    const storage =
      discovered.session === "authenticated" ? ctx.storageState : undefined;
    const { context, page, network } = await openPage(
      ctx.browser,
      ctx.config,
      storage,
    );
    try {
      await navigate(page, discovered.graph.route);
      const first = splitByCause(await audit(page, network));
      if (first.size === 0) continue;
      await page.reload({ waitUntil: "domcontentloaded" });
      const second = splitByCause(await audit(page, network));

      const pattern = toPattern(discovered.graph.route);
      for (const [key, { violation, cause }] of first) {
        const hits = rules.get(key) ?? { violation, cause, pages: [] };
        hits.pages.push({ pattern, violation, reproduced: second.has(key) });
        rules.set(key, hits);
      }
    } catch {
      // A page that fails to load here was already reported by the crawl.
    } finally {
      await context.close();
    }
  }

  return [...rules.entries()].map(([key, hits]) => {
    const v = hits.violation;
    const help = hits.cause ? `${v.help}: ${hits.cause}` : v.help;
    const criteria = successCriteria(v.tags);
    const patterns = hits.pages.map((p) => p.pattern);
    const elements = hits.pages.reduce(
      (n, p) => n + p.violation.nodes.length,
      0,
    );
    const reproducedOn = hits.pages
      .filter((p) => p.reproduced)
      .map((p) => p.pattern);
    const examples = hits.pages
      .flatMap((p) => describeNodes(p.violation, p.pattern, 2))
      .slice(0, 4);

    return {
      key: `a11y::${key}`,
      title:
        patterns.length === 1
          ? `${help} (${patterns[0]})`
          : `${help} (${patterns.length} pages)`,
      kind: "improvement",
      level: 0,
      levelReason: "",
      route: patterns.length === 1 ? patterns[0] : "(several pages)",
      contracts: [],
      source: "heuristic",
      heuristic: v.id,
      evidence: [
        `axe-core rule "${v.id}", impact ${v.impact ?? "unknown"}: ${elements} element(s) on ${patterns.join(", ")}`,
        ...examples,
        ...(elements > examples.length
          ? [`… and ${elements - examples.length} more`]
          : []),
        `reference: ${v.helpUrl}`,
        reproducedOn.length
          ? `present again after reloading ${reproducedOn.join(", ")}`
          : "not present after reloading",
      ],
      results: [],
      reproduced: reproducedOn.length > 0,
      standard: criteria.length
        ? `WCAG 2.1 success criterion ${criteria.join(", ")}`
        : undefined,
    } satisfies Finding;
  });
}
