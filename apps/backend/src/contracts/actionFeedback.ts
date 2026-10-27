import { ContractCheck } from "./types";
import { feedbackSignals, messageEvidence } from "./feedbackSignals";

/**
 * Action Feedback — after a user submits a filled form, the app must
 * visibly respond: navigate, show a message, mark fields invalid, or open
 * a dialog. Success and rejection both satisfy this contract; what it
 * catches is silence, where the user can't tell whether anything happened.
 */
export const checkActionFeedback: ContractCheck = (obs) => {
  // Hello world!
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
    // Our generated values may simply not meet this app's rules (password
    // policy, format), so a disabled button here says nothing definite.
    return {
      verdict: "AMBIGUOUS",
      evidence: [
        `"${obs.candidate.submit?.label}" stayed disabled after every field was filled with generated values`,
      ],
    };
  }

  const signals = feedbackSignals(obs.before, obs.after);
  const evidence = messageEvidence(signals, obs.nativeDialogs);
  if (signals.routeChanged)
    evidence.unshift(`navigated ${obs.before.route} → ${obs.after.route}`);
  if (signals.headingsChanged && !signals.routeChanged)
    evidence.push("page headings changed");
  if (obs.nativeValidationBlocked)
    evidence.push("browser constraint validation blocked the submission");

  if (evidence.length) {
    return { verdict: "SATISFIED", evidence };
  }

  return {
    verdict: "VIOLATION",
    evidence: [
      "submitted with every field filled",
      `route stayed ${obs.after.route}`,
      "no message, no navigation, no field marked invalid, no dialog",
    ],
  };
};
