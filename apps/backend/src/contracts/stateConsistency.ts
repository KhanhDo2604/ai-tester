import { sameItems } from "../state/diff";
import { ContractCheck } from "./types";
import { quoteList } from "./feedbackSignals";

/**
 * State Consistency — the UI right after an action must agree with what
 * the app shows when the same page is loaded fresh.
 *
 * This is the in-session form of README Section 4's "two visible
 * representations of one value": the post-action UI is one
 * representation, and the freshly loaded page (rebuilt from whatever the
 * app persisted) is the other. Only persistent regions — navigation and
 * banner landmarks, plus page headings — are compared. Toasts and success
 * messages are transient by design and are expected to disappear on
 * reload, so they are left out.
 *
 * A state the explorer found a reload does not return to (the app keeps
 * that screen in memory only) is not compared: the reload shows another
 * screen by design, which says nothing about stale data.
 */
export const checkStateConsistency: ContractCheck = (obs) => {
  if (obs.error) {
    return {
      verdict: "AMBIGUOUS",
      evidence: [`interaction could not be completed: ${obs.error}`],
    };
  }
  if (!obs.after || !obs.afterReload) {
    return {
      verdict: "NOT_APPLICABLE",
      evidence: [
        "the action did not run, so there is no post-action state to compare",
      ],
    };
  }

  if (obs.afterInMemoryOnly) {
    return {
      verdict: "NOT_APPLICABLE",
      evidence: [
        "the action led to a screen the app keeps only in memory; a reload returns to another screen, so there is nothing to compare",
      ],
    };
  }

  const after = obs.after;
  const reloaded = obs.afterReload;

  if (after.route !== reloaded.route) {
    return {
      verdict: "AMBIGUOUS",
      evidence: [`reloading ${after.route} landed on ${reloaded.route}`],
    };
  }

  const evidence: string[] = [];
  if (!sameItems(after.navigation, reloaded.navigation)) {
    evidence.push(
      `navigation right after the action: ${quoteList(after.navigation, 8)}`,
    );
    evidence.push(
      `navigation after reloading the same page: ${quoteList(reloaded.navigation, 8)}`,
    );
  }
  if (!sameItems(after.headings, reloaded.headings)) {
    evidence.push(
      `headings right after the action: ${quoteList(after.headings, 8)}`,
    );
    evidence.push(
      `headings after reloading the same page: ${quoteList(reloaded.headings, 8)}`,
    );
  }

  if (evidence.length) {
    return {
      verdict: "VIOLATION",
      evidence: [
        `on ${after.route}, the UI disagrees with a fresh load of the same page`,
        ...evidence,
      ],
    };
  }

  return {
    verdict: "SATISFIED",
    evidence: [`navigation and headings on ${after.route} match a fresh load`],
  };
};
