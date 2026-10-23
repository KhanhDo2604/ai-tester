import { StateSignature } from "./signature";

/**
 * One observable difference between two signatures. Contracts read these
 * instead of comparing signatures themselves, so "what changed" is
 * computed in one place, and a later step can ask which changes a
 * contract did not expect (Unexpected Change Promotion).
 */
export type StateChange =
  | { kind: "routeChanged"; from: string; to: string }
  | { kind: "headingAdded" | "headingRemoved"; text: string }
  | { kind: "navigationAdded" | "navigationRemoved"; text: string }
  | { kind: "alertAppeared" | "alertCleared"; text: string }
  | { kind: "textAppeared" | "textDisappeared"; text: string }
  | { kind: "dialogOpened" | "dialogClosed"; label: string }
  | { kind: "fieldBecameInvalid"; label: string }
  | { kind: "fieldAdded" | "fieldRemoved"; label: string }
  | { kind: "controlAdded" | "controlRemoved"; label: string }
  | { kind: "controlDisabled" | "controlEnabled"; label: string };

export type ChangeKind = StateChange["kind"];
type ChangeOf<K extends ChangeKind> = Extract<StateChange, { kind: K }>;

/** Items present in `after` but not in `before` (set semantics, order kept). */
export function addedItems(before: string[], after: string[]): string[] {
  const seen = new Set(before);
  return [...new Set(after)].filter((item) => !seen.has(item));
}

/** True when both lists contain exactly the same distinct items, ignoring order. */
export function sameItems(a: string[], b: string[]): boolean {
  return addedItems(a, b).length === 0 && addedItems(b, a).length === 0;
}

function setChanges(
  before: string[],
  after: string[],
  added: (value: string) => StateChange,
  removed: (value: string) => StateChange,
): StateChange[] {
  return [
    ...addedItems(before, after).map(added),
    ...addedItems(after, before).map(removed),
  ];
}

export function diffSignatures(
  before: StateSignature,
  after: StateSignature,
): StateChange[] {
  const changes: StateChange[] = [];
  if (before.route !== after.route)
    changes.push({ kind: "routeChanged", from: before.route, to: after.route });

  changes.push(
    ...setChanges(
      before.headings,
      after.headings,
      (text) => ({ kind: "headingAdded", text }),
      (text) => ({ kind: "headingRemoved", text }),
    ),
  );
  changes.push(
    ...setChanges(
      before.navigation,
      after.navigation,
      (text) => ({ kind: "navigationAdded", text }),
      (text) => ({ kind: "navigationRemoved", text }),
    ),
  );
  changes.push(
    ...setChanges(
      before.alerts,
      after.alerts,
      (text) => ({ kind: "alertAppeared", text }),
      (text) => ({ kind: "alertCleared", text }),
    ),
  );
  changes.push(
    ...setChanges(
      before.texts,
      after.texts,
      (text) => ({ kind: "textAppeared", text }),
      (text) => ({ kind: "textDisappeared", text }),
    ),
  );
  changes.push(
    ...setChanges(
      before.dialogs,
      after.dialogs,
      (label) => ({ kind: "dialogOpened", label }),
      (label) => ({ kind: "dialogClosed", label }),
    ),
  );

  const invalidBefore = new Set(
    before.fields.filter((f) => f.invalid).map((f) => f.label),
  );
  for (const field of after.fields) {
    if (field.invalid && !invalidBefore.has(field.label)) {
      changes.push({
        kind: "fieldBecameInvalid",
        label: field.label || "(unlabelled field)",
      });
    }
  }
  const labels = (sig: StateSignature) => sig.fields.map((f) => f.label);
  changes.push(
    ...setChanges(
      labels(before),
      labels(after),
      (label) => ({ kind: "fieldAdded", label }),
      (label) => ({ kind: "fieldRemoved", label }),
    ),
  );

  const buttons = (sig: StateSignature) => sig.buttons.map((b) => b.label);
  changes.push(
    ...setChanges(
      buttons(before),
      buttons(after),
      (label) => ({ kind: "controlAdded", label }),
      (label) => ({ kind: "controlRemoved", label }),
    ),
  );
  const disabledBefore = new Map(
    before.buttons.map((b) => [b.label, b.disabled]),
  );
  for (const button of after.buttons) {
    const was = disabledBefore.get(button.label);
    if (was === undefined || was === button.disabled) continue;
    changes.push({
      kind: button.disabled ? "controlDisabled" : "controlEnabled",
      label: button.label,
    });
  }

  return changes;
}

/** The changes of one kind. */
export function changesOf<K extends ChangeKind>(
  changes: StateChange[],
  kind: K,
): ChangeOf<K>[] {
  return changes.filter((c): c is ChangeOf<K> => c.kind === kind);
}

/** The text or label of every change of the given kind. */
export function valuesOf(
  changes: StateChange[],
  kind: Exclude<ChangeKind, "routeChanged">,
): string[] {
  return changesOf(changes, kind).map((c) => ("text" in c ? c.text : c.label));
}
