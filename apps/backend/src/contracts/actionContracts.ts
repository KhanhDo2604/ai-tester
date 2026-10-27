import { ContractName } from "../candidates/types";
import { ActionObservation } from "../discovery/executeAction";
import { valuesOf } from "../state/diff";
import { feedbackSignals, messageEvidence, quoteList } from "./feedbackSignals";
import { describeRequests, serverErrorResult } from "./noServerError";
import { ContractResult } from "./types";

type Check = Pick<ContractResult, "verdict" | "evidence">;

/**
 * Contract Check for standalone actions (Phase 3). Which contracts apply
 * follows from the discovered contract:
 *
 * - ActionEffect and NoServerError: every executed action.
 * - ConfirmBeforeDestructive: only when the model said a reasonable user
 *   would expect a confirmation. This one is "discovered" — it rests on
 *   the model's hypothesis, not a hand-written rule.
 * - DeletionEffective: destructive actions only.
 */
export function checkActionContracts(obs: ActionObservation): ContractResult[] {
  const { action } = obs;
  const id = `${action.routePattern} :: ${action.control.label}`;
  const result = (
    contract: ContractName,
    check: Check,
    source: ContractResult["source"] = "predefined",
  ): ContractResult => ({
    contract,
    candidateId: id,
    route: obs.instance?.path ?? action.routePattern,
    source,
    ...check,
  });

  if (!obs.executed) {
    return [
      result("ActionEffect", {
        verdict: "NOT_APPLICABLE",
        evidence: [
          `not executed: ${obs.skipReason ?? obs.error ?? "unknown reason"}`,
        ],
      }),
    ];
  }

  const results = [
    result("ActionEffect", checkActionEffect(obs)),
    result(
      "NoServerError",
      serverErrorResult(
        [...obs.requests, ...(obs.revisit?.requests ?? [])],
        obs.error,
      ),
    ),
  ];
  if (action.contract?.requiresConfirmation) {
    results.push(
      result("ConfirmBeforeDestructive", checkConfirmation(obs), "discovered"),
    );
  }
  if (action.contract?.category === "destructive") {
    results.push(result("DeletionEffective", checkDeletion(obs)));
  }
  return results;
}

/** Clicking must visibly do something: navigate, show a message, or change the page's content or controls. */
function checkActionEffect(obs: ActionObservation): Check {
  if (obs.error)
    return {
      verdict: "AMBIGUOUS",
      evidence: [`action could not be completed: ${obs.error}`],
    };
  if (!obs.before || !obs.after)
    return {
      verdict: "NOT_APPLICABLE",
      evidence: ["no before/after state captured"],
    };

  const signals = feedbackSignals(obs.before, obs.after);
  const evidence = messageEvidence(signals, obs.nativeDialogs);
  if (signals.routeChanged)
    evidence.unshift(`navigated ${obs.before.route} → ${obs.after.route}`);

  const appeared = valuesOf(signals.changes, "controlAdded");
  const disappeared = valuesOf(signals.changes, "controlRemoved");
  if (!signals.routeChanged && (appeared.length || disappeared.length)) {
    if (disappeared.length)
      evidence.push(`controls removed: ${quoteList(disappeared)}`);
    if (appeared.length)
      evidence.push(`controls added: ${quoteList(appeared)}`);
  }

  if (evidence.length) return { verdict: "SATISFIED", evidence };
  return {
    verdict: "VIOLATION",
    evidence: [
      `clicked "${obs.action.control.label}" on ${obs.instance?.path}`,
      "nothing on the page changed: no message, no navigation, no change in content or controls",
    ],
  };
}

/**
 * The discovered expectation "this should ask for confirmation first".
 *
 * An undo affordance after the action also satisfies it: undo-after-delete
 * is a deliberate, widely used alternative to a confirmation dialog, and
 * the model, seeing only a label, can't know which one the app chose
 * (README Section 5, "Known risk"). Detecting undo is English keyword
 * matching on the post-action page — a known limitation.
 */
function checkConfirmation(obs: ActionObservation): Check {
  const hypothesis =
    `hypothesis (from the model): a user expects to confirm "${obs.action.control.label}" before it takes effect` +
    (obs.action.contract?.expectation
      ? ` — "${obs.action.contract.expectation}"`
      : "");
  if (obs.confirmationShown) {
    return {
      verdict: "SATISFIED",
      evidence: [
        hypothesis,
        `confirmation shown; ${obs.confirmationAnswer ?? "answered"}`,
      ],
    };
  }

  const undo = [
    ...(obs.after?.buttons.map((b) => b.label) ?? []),
    ...(obs.after?.texts ?? []),
  ].find((t) => /\bundo\b/i.test(t));
  if (undo) {
    return {
      verdict: "SATISFIED",
      evidence: [
        hypothesis,
        `no confirmation, but an undo option appeared: "${undo}"`,
      ],
    };
  }

  const tookEffect = obs.revisit ? !obs.revisit.markerPresent : undefined;
  if (tookEffect === false) {
    return {
      verdict: "AMBIGUOUS",
      evidence: [
        hypothesis,
        "no confirmation appeared, but the record also wasn't removed",
      ],
    };
  }
  return {
    verdict: "VIOLATION",
    evidence: [
      hypothesis,
      "no confirmation dialog and no undo option: the action took effect immediately on one click",
    ],
  };
}

/** After a deletion, the record's own page must no longer show it. A "not found" response there is the correct outcome. */
function checkDeletion(obs: ActionObservation): Check {
  if (!obs.revisit)
    return {
      verdict: "NOT_APPLICABLE",
      evidence: ["record page was not reopened after the action"],
    };

  const notFound = obs.revisit.requests.filter(
    (r) => r.status === 404 || r.status === 410,
  );
  if (obs.revisit.markerPresent) {
    return {
      verdict: "VIOLATION",
      evidence: [
        `reopened ${obs.instance?.path} after "${obs.action.control.label}"`,
        "the record is still shown",
      ],
    };
  }
  return {
    verdict: "SATISFIED",
    evidence: [
      `reopened ${obs.instance?.path}: the record is gone`,
      ...describeRequests(notFound).map(
        (line) => `${line}, the correct response for a removed record`,
      ),
      ...obs.revisit.signature.texts
        .slice(0, 2)
        .map((t) => `page shows: "${t}"`),
    ],
  };
}
