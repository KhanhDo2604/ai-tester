import { StateSignature } from "../state/signature";

/**
 * Collapses ids in a path so /tasks/12 and /tasks/57 count as one page
 * shape (/tasks/:id).
 */
export function routePattern(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) =>
      /^\d+$/.test(segment) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment) ||
      /^[0-9a-f]{24}$/i.test(segment)
        ? ":id"
        : segment,
    )
    .join("/");
}

const sortedSet = (items: string[]) =>
  [...new Set(items.map((i) => i.replace(/\d+/g, "#")))].sort();

/**
 * Abstract identity of a UI state: what screen this is, not what data it
 * shows. Route pattern, headings, open dialogs and field labels, with
 * numbers ignored and free text left out, so "Cart (2)" and "Cart (3)" are
 * one state while the login screen and the task list are two, even on the
 * same URL.
 */
export function stateKey(signature: StateSignature): string {
  return [
    routePattern(signature.route),
    sortedSet(signature.headings).join("|"),
    sortedSet(signature.dialogs).join("|"),
    sortedSet(signature.fields.map((f) => f.label)).join("|"),
  ].join(" ¦ ");
}
