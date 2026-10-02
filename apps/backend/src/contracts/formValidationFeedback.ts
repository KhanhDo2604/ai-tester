import { ContractCheck } from "./types";
import { feedbackSignals, messageEvidence } from "./feedbackSignals";

/**
 * Form Validation Feedback — submitting a form with every field empty must
 * either be prevented or produce visible feedback.
 *
 * Prevention counts as correct behaviour, not as a missing feature: a
 * submit button that stays disabled until required input is present is a
 * deliberate, valid design. Treating it as "no feedback" is the classic
 * false positive this contract is written to avoid.
 */
export const checkFormValidationFeedback: ContractCheck = (obs) => {
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

  if (obs.submitDisabled) {
    return {
      verdict: "SATISFIED",
      evidence: [
        `submission prevented: "${obs.candidate.submit?.label}" is disabled while the fields are empty`,
      ],
    };
  }
  if (obs.nativeValidationBlocked) {
    return {
      verdict: "SATISFIED",
      evidence: ["browser constraint validation blocked the submission"],
    };
  }

  const signals = feedbackSignals(obs.before, obs.after);
  const messages = messageEvidence(signals, obs.nativeDialogs);

  if (signals.routeChanged) {
    // The app accepted an empty submission. That's a bug if a field is
    // really mandatory and fine if they are all optional — the UI alone
    // can't tell which, so this is exactly the case for LLM judgment.
    return {
      verdict: "AMBIGUOUS",
      evidence: [
        `empty submission was accepted: route changed ${obs.before.route} → ${obs.after.route}`,
        ...messages,
      ],
    };
  }

  if (messages.length) {
    return { verdict: "SATISFIED", evidence: messages };
  }

  return {
    verdict: "VIOLATION",
    evidence: [
      "submitted with all fields empty",
      `route stayed ${obs.after.route}`,
      obs.candidate.submitMode === "enter"
        ? "no error message, no field marked invalid, no dialog after pressing Enter"
        : "no error message, no field marked invalid, no dialog, submit control was enabled",
    ],
  };
};
