import { FieldState } from "./signature";

/** Items present in `after` but not in `before` (set semantics, order kept). */
export function addedItems(before: string[], after: string[]): string[] {
  const seen = new Set(before);
  return [...new Set(after)].filter((item) => !seen.has(item));
}

/** True when both lists contain exactly the same distinct items, ignoring order. */
export function sameItems(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const item of setA) {
    if (!setB.has(item)) return false;
  }
  return true;
}

/** Labels of fields that are invalid in `after` but were not invalid in `before`. */
export function newlyInvalidFields(
  before: FieldState[],
  after: FieldState[],
): string[] {
  const invalidBefore = new Set(
    before.filter((f) => f.invalid).map((f) => f.label),
  );
  return after
    .filter((f) => f.invalid && !invalidBefore.has(f.label))
    .map((f) => f.label || "(unlabelled field)");
}
