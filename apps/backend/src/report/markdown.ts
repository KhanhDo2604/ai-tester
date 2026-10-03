import { ReportItem } from "./types";

/** A finding as a GitHub-flavoured Markdown issue body, ready to paste into a tracker. */
export function toMarkdown(
  item: Omit<ReportItem, "markdown">,
  target: string,
): string {
  return [
    `## ${item.title}`,
    "",
    `**Type:** ${item.kind === "bug" ? "Bug" : "Improvement"} · ${item.levelLabel}  `,
    `**Where:** ${target}${item.route.startsWith("/") ? item.route : ` ${item.route}`}`,
    "",
    item.summary,
    "",
    "### Steps to reproduce",
    ...item.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "### Expected",
    item.expected,
    "",
    "### Actual",
    item.actual,
    "",
    "### Why we believe this",
    item.whyLevel + (item.standard ? `  \nStandard: ${item.standard}` : ""),
    "",
    "<details><summary>Technical evidence</summary>",
    "",
    ...item.evidence.map((e) => `- ${e}`),
    "",
    "</details>",
    "",
    "_Reported by AI App Tester_",
  ].join("\n");
}
