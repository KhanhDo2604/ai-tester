import { FieldTarget } from "../candidates/types";
import { formatKind } from "../execution/fillValues";
import { ContractCheck } from "./types";
import { feedbackSignals, messageEvidence, quoteList } from "./feedbackSignals";

/**
 * Format Validation — a value that is malformed for its field (an email
 * without "@", a URL that isn't one) must not be accepted.
 *
 * Verdicts:
 * - Rejected visibly (submit disabled, browser validation, field marked
 *   invalid, an alert): SATISFIED.
 * - Accepted (the app moved on to another page): VIOLATION — the
 *   malformed value is now stored.
 * - Same page, but only plain text appeared: AMBIGUOUS. That text could be
 *   an error ("Enter a valid email") or a success message ("Profile
 *   updated."), and telling them apart is a language judgment — exactly
 *   what LLM Semantic Judgment (Phase 4) is for.
 * - Nothing happened at all: VIOLATION — the user gets no indication of
 *   what is wrong with their input.
 */
export const checkFormatValidation: ContractCheck = (obs) => {
  if (obs.error) {
    return {
      verdict: "AMBIGUOUS",
      evidence: [`interaction could not be completed: ${obs.error}`],
    };
  }
  if (!obs.before || !obs.after) {
    return {
      verdict: "NOT_APPLICABLE",
      evidence: ["no before/after state captured"],
    };
  }

  const malformed = describeMalformedFields(obs.candidate.fields);

  if (obs.submitDisabled) {
    return {
      verdict: "SATISFIED",
      evidence: [`${malformed}: submit control stayed disabled`],
    };
  }
  if (obs.nativeValidationBlocked) {
    return {
      verdict: "SATISFIED",
      evidence: [
        `${malformed}: browser constraint validation blocked the submission`,
      ],
    };
  }

  const signals = feedbackSignals(obs.before, obs.after);

  if (signals.routeChanged) {
    return {
      verdict: "VIOLATION",
      evidence: [
        `${malformed}: accepted`,
        `navigated ${obs.before.route} → ${obs.after.route}`,
      ],
    };
  }

  if (
    signals.newlyInvalid.length ||
    signals.newAlerts.length ||
    signals.newDialogs.length ||
    obs.nativeDialogs.length
  ) {
    return {
      verdict: "SATISFIED",
      evidence: [
        `${malformed}: rejected`,
        ...messageEvidence(signals, obs.nativeDialogs),
      ],
    };
  }

  if (signals.newTexts.length) {
    return {
      verdict: "AMBIGUOUS",
      evidence: [
        malformed,
        `page stayed on ${obs.after.route}; new text appeared: ${quoteList(signals.newTexts)}`,
        "whether this text is an error or a success message needs semantic judgment",
      ],
    };
  }

  return {
    verdict: "VIOLATION",
    evidence: [
      malformed,
      `page stayed on ${obs.after.route} with no message, no invalid field, no dialog`,
    ],
  };
};

function describeMalformedFields(fields: FieldTarget[]): string {
  const formatFields = fields
    .filter((f) => !f.disabled && formatKind(f) !== undefined)
    .map((f) => `"${f.label}" (${formatKind(f)})`);
  return `malformed value in ${formatFields.join(", ")}, every other field valid`;
}
