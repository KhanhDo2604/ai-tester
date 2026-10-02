import { addedItems, newlyInvalidFields, sameItems } from "../state/diff";
import { StateSignature } from "../state/signature";

/**
 * Every observable way an app can respond to a submission, computed once
 * from a before/after pair. Both Form Validation Feedback and Action
 * Feedback read from this, so "what counts as feedback" is defined in one
 * place.
 */
export interface FeedbackSignals {
  routeChanged: boolean;
  newAlerts: string[];
  newTexts: string[];
  newlyInvalid: string[];
  newDialogs: string[];
  headingsChanged: boolean;
}

export function feedbackSignals(
  before: StateSignature,
  after: StateSignature,
): FeedbackSignals {
  return {
    routeChanged: before.route !== after.route,
    newAlerts: addedItems(before.alerts, after.alerts),
    newTexts: addedItems(before.texts, after.texts),
    newlyInvalid: newlyInvalidFields(before.fields, after.fields),
    newDialogs: addedItems(before.dialogs, after.dialogs),
    headingsChanged: !sameItems(before.headings, after.headings),
  };
}

/**
 * Evidence lines for whichever in-page messages appeared.
 *
 * When the route changed, plain text is left out: everything on the new
 * page is "new text" (list items, names, column labels), so listing it
 * would bury the actual signal — the navigation — under page content.
 * Alerts and dialogs are still reported, since they are messages by role.
 */
export function messageEvidence(
  signals: FeedbackSignals,
  nativeDialogs: string[],
): string[] {
  const evidence: string[] = [];
  if (signals.newAlerts.length)
    evidence.push(`alert appeared: ${quoteList(signals.newAlerts)}`);
  if (signals.newlyInvalid.length)
    evidence.push(`fields marked invalid: ${quoteList(signals.newlyInvalid)}`);
  if (signals.newDialogs.length)
    evidence.push(`dialog opened: ${quoteList(signals.newDialogs)}`);
  if (nativeDialogs.length)
    evidence.push(`browser dialog shown: ${quoteList(nativeDialogs)}`);
  // Alert text is also part of `texts`; only list text that isn't already reported as an alert.
  const plainTexts = signals.newTexts.filter(
    (t) => !signals.newAlerts.some((a) => a.includes(t)),
  );
  if (plainTexts.length && !signals.routeChanged)
    evidence.push(`new text appeared: ${quoteList(plainTexts)}`);
  return evidence;
}

export function quoteList(items: string[], max = 4): string {
  const shown = items
    .slice(0, max)
    .map((i) => `"${i}"`)
    .join(", ");
  return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
}
