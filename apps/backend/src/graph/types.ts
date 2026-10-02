/**
 * UI Semantic Graph — see README Section 3.
 *
 * This is the normalized, structured representation that everything
 * downstream (Interaction Candidate Detection, Contract Check, etc.) is
 * built on top of. Nothing past this layer should ever read the raw
 * Playwright accessibility snapshot or the DOM directly.
 */

export interface UISemanticGraphNode {
  /** The CDP accessibility node id — unique within one capture. */
  id: string;

  /**
   * Normalized structural type. Kept to a small, fixed vocabulary so
   * Interaction Candidate Detection can pattern-match on it reliably.
   * "text" is visible text content that isn't already part of a
   * control's accessible name (e.g. "No tasks yet.", an inline error
   * message) — the State Signature needs it to see feedback messages.
   */
  type:
    | "form"
    | "input"
    | "button"
    | "link"
    | "heading"
    | "dialog"
    | "alert"
    | "text"
    | "container";

  /** The ARIA role as read from the accessibility tree. */
  role: string;

  /** The accessible name / visible label for this node. */
  label?: string;

  /** Behavioural/validation state read from the accessibility tree. */
  state: {
    required?: boolean;
    invalid?: boolean;
    disabled?: boolean;
    checked?: boolean;
    expanded?: boolean;
  };

  /** Extra attributes the accessibility tree doesn't expose, read from the DOM subset. */
  domExtra?: {
    tag?: string;
    href?: string;
    inputType?: string;
    hidden?: boolean;
  };

  /** Child nodes. Preserving this structure is what lets a rule recognize
   *  "an input inside a form", not just "an input exists somewhere". */
  children: UISemanticGraphNode[];
}

/** The full graph for one page at one point in time. */
export interface UISemanticGraph {
  /** The route (pathname) this graph was captured from. */
  route: string;

  /** The root node of the page. */
  root: UISemanticGraphNode;
}
