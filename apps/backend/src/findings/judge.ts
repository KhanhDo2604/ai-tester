import { ContractName } from "../candidates/types";
import { ContractResult } from "../contracts/types";
import { LlmClient } from "../llm/types";
import { CheckedResult, Judgment, subjectName, subjectRoute } from "./types";

const SYSTEM_PROMPT =
  "You judge whether one observed behaviour of a web application violates an expectation. " +
  "Use only the facts given. Answer with JSON that matches the schema exactly.";

const SCHEMA = {
  type: "object",
  properties: {
    violated: { type: "boolean" },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["violated", "confidence", "reason"],
};

const EXPECTATIONS: Record<ContractName, string> = {
  FormValidationFeedback:
    "Submitting a form with every field empty must be prevented or produce visible feedback.",
  FormatValidation:
    "A malformed value (an invalid email address or URL) must be rejected with visible feedback, not accepted.",
  ActionFeedback: "Submitting a filled form must produce a visible response.",
  StateConsistency:
    "The page right after an action must match a fresh load of the same page.",
  NoServerError: "A user action must not make the server fail.",
  ActionEffect: "Clicking the control must visibly do something.",
  ConfirmBeforeDestructive:
    "A destructive action should ask for confirmation or offer undo.",
  DeletionEffective: "After a deletion, the record must no longer be shown.",
};

/** AMBIGUOUS because the action itself failed — nothing was observed, so there is nothing to judge. */
export function isExecutionFailure(r: ContractResult): boolean {
  return r.evidence.some((e) => e.includes("could not be completed"));
}

/** Generated values carry a run id; masking it keeps the question identical across scans. */
function maskRunIds(text: string): string {
  return text.replace(
    /(ai-tester\+|AI Tester sample |not-an-email-|not a url |aitester_)[a-z0-9]+/g,
    "$1<id>",
  );
}

function describeAction(c: CheckedResult): string {
  const name = subjectName(c.subject);
  const route = subjectRoute(c.subject);
  if (c.subject.kind === "action") return `clicked "${name}" on ${route}`;
  switch (c.subject.candidate.strategy) {
    case "emptySubmit":
      return `submitted "${name}" on ${route} with every field empty`;
    case "invalidFormat":
      return `submitted "${name}" on ${route} with a malformed value in a format field, every other field valid`;
    default:
      return `submitted "${name}" on ${route} with every field filled with valid values`;
  }
}

export function buildJudgmentPrompt(c: CheckedResult): string {
  return [
    `Expectation: ${EXPECTATIONS[c.result.contract]}`,
    `Action: ${describeAction(c)}`,
    "Observed:",
    // Engine notes ("needs semantic judgment") are not observations and would bias the answer.
    ...c.result.evidence
      .filter((e) => !/semantic judgment/.test(e))
      .map((e) => `- ${maskRunIds(e)}`),
    "",
    "violated: true if the observed behaviour breaks the expectation.",
    "confidence: 0 to 1.",
    "reason: one sentence.",
  ].join("\n");
}

/** LLM Semantic Judgment — README §8. Only AMBIGUOUS results that were actually observed get here. */
export async function judge(
  llm: LlmClient | undefined,
  c: CheckedResult,
): Promise<Judgment | undefined> {
  if (!llm || c.result.verdict !== "AMBIGUOUS" || isExecutionFailure(c.result))
    return undefined;
  try {
    const answer = await llm.completeJson<Judgment>({
      system: SYSTEM_PROMPT,
      user: buildJudgmentPrompt(c),
      schema: SCHEMA,
    });
    if (typeof answer?.violated !== "boolean") return undefined;
    const confidence = Math.min(1, Math.max(0, Number(answer.confidence) || 0));
    return {
      violated: answer.violated,
      confidence,
      reason: String(answer.reason ?? "").trim(),
    };
  } catch {
    return undefined;
  }
}
