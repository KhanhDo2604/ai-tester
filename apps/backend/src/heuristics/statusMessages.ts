import { ContractName } from "../candidates/types";
import {
  CheckedResult,
  Finding,
  subjectName,
  subjectRoute,
} from "../findings/types";

/** Error messages only: after a filled submit, new text is usually content the action created, not a message. */
const ERROR_CONTRACTS: ContractName[] = [
  "FormValidationFeedback",
  "FormatValidation",
];
const NEW_TEXT = /^new text appeared: (.+)$/;

/**
 * WCAG 4.1.3 (Status Messages): an error message that appears after
 * submitting, without moving focus or page, must be in a live region (role
 * alert/status) or screen-reader users never hear it. Reuses what the form
 * checks already observed; no extra browsing.
 *
 * All occurrences become one finding, since the cause is usually one shared
 * pattern in the app's code. It counts as repeated when seen in at least two
 * separate interactions.
 */
export function checkStatusMessages(checked: CheckedResult[]): Finding[] {
  const occurrences = new Map<string, string>();

  for (const c of checked) {
    if (
      c.subject.kind !== "form" ||
      !ERROR_CONTRACTS.includes(c.result.contract)
    )
      continue;
    if (
      c.result.evidence.some(
        (e) => e.startsWith("alert appeared") || e.startsWith("navigated"),
      )
    )
      continue;
    for (const line of c.result.evidence) {
      const m = line.match(NEW_TEXT);
      if (!m) continue;
      for (const text of m[1].match(/"[^"]+"/g) ?? []) {
        const where = `${subjectRoute(c.subject)} "${subjectName(c.subject)}"`;
        occurrences.set(
          `${where}::${text}`,
          `${where}: ${text} appeared as plain text`,
        );
      }
    }
  }

  if (occurrences.size === 0) return [];
  const lines = [...occurrences.values()];
  return [
    {
      key: "heuristic::status-messages",
      title: "Form error messages are not announced to screen readers",
      kind: "improvement",
      level: 0,
      levelReason: "",
      route: "(several pages)",
      contracts: [],
      source: "heuristic",
      heuristic: "status-messages",
      evidence: [
        'error messages appeared after submitting without role="alert" or role="status", so assistive technology does not announce them',
        ...lines.slice(0, 6),
        ...(lines.length > 6 ? [`… and ${lines.length - 6} more`] : []),
        `seen in ${lines.length} interaction(s)`,
      ],
      results: [],
      reproduced: lines.length >= 2,
      standard: "WCAG 2.1 success criterion 4.1.3 (Status Messages)",
    },
  ];
}
