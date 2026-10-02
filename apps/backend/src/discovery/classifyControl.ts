import { LlmClient } from "../llm/types";
import {
  ACTION_CATEGORIES,
  ActionTarget,
  ClassifiedAction,
  DiscoveredContract,
} from "./types";

const SYSTEM_PROMPT =
  "You classify one control of a web application for an automated tester. " +
  "Judge only from the label and the context given. Answer with JSON that matches the schema exactly.";

const SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...ACTION_CATEGORIES] },
    expectation: { type: "string" },
    requiresConfirmation: { type: "boolean" },
  },
  required: ["category", "expectation", "requiresConfirmation"],
} as const;

/**
 * Builds the compact context for one control — README Section 5: the
 * control's label and where it sits, nothing else. No DOM, no screenshot,
 * no full graph. A typical message is well under 200 tokens.
 *
 * Page headings are included only for pages that are not about one
 * specific record. On a record page (a route pattern with ":id") the
 * headings are that record's own data — a task title, a customer name —
 * so they are left out:
 * - the model never receives the app's user data, which matters once the
 *   model is a hosted service rather than a local one;
 * - the question for a control is identical on every scan, whichever
 *   record the crawl happened to reach first, so cached answers stay valid.
 * The label and the route pattern carry what classification needs.
 */
export function buildDiscoveryPrompt(target: ActionTarget): string {
  const { control, routePattern } = target;
  const location =
    control.region === "persistent"
      ? "site navigation, repeated on every page"
      : "main content of the page";
  const isRecordPage = routePattern.includes(":id");
  const pageLine = isRecordPage
    ? `Page: ${routePattern} (a page showing one specific record; its content is not included)`
    : `Page: ${routePattern} (headings: ${
        control.pageHeadings
          .slice(0, 3)
          .map((h) => `"${h}"`)
          .join(", ") || "(none)"
      })`;

  return [
    `Control: ${control.role} "${control.label}"`,
    pageLine,
    `Location: ${location}`,
    "",
    "category — what clicking it does:",
    "- destructive: permanently deletes or removes data",
    "- state-change: changes data without deleting it (complete, archive, publish, toggle, save)",
    "- navigation: only moves to another page or view",
    "- session: logs out, switches account, or ends the session",
    "- export: downloads or exports data",
    "- unknown: the label does not say",
    "",
    "expectation — one sentence: what a reasonable user expects to happen after clicking.",
    "requiresConfirmation — true only if a reasonable user would expect to be asked to confirm before it takes effect.",
  ].join("\n");
}

/**
 * Semantic Contract Discovery — README Section 5. One LLM call per
 * distinct control (the cache makes repeat scans free). A malformed or
 * failed answer is recorded as such; the control is then simply not
 * executed, rather than executed on a guess.
 */
export async function classifyControl(
  llm: LlmClient | undefined,
  target: ActionTarget,
): Promise<ClassifiedAction> {
  if (!llm)
    return {
      ...target,
      classificationError: "no LLM configured (LLM_PROVIDER=none)",
    };

  try {
    const answer = await llm.completeJson<DiscoveredContract>({
      system: SYSTEM_PROMPT,
      user: buildDiscoveryPrompt(target),
      schema: SCHEMA as unknown as Record<string, unknown>,
    });
    return { ...target, contract: validate(answer) };
  } catch (err) {
    return {
      ...target,
      classificationError: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Small models occasionally drift from the schema; anything off-schema is rejected, not patched. */
function validate(answer: DiscoveredContract): DiscoveredContract {
  if (!ACTION_CATEGORIES.includes(answer?.category)) {
    throw new Error(
      `model returned an unknown category: ${JSON.stringify(answer?.category)}`,
    );
  }
  if (typeof answer.requiresConfirmation !== "boolean") {
    throw new Error("model did not return requiresConfirmation as a boolean");
  }
  return {
    category: answer.category,
    expectation: String(answer.expectation ?? "").trim(),
    requiresConfirmation: answer.requiresConfirmation,
  };
}
