export type SessionKind = "anonymous" | "authenticated";

export type ContractName =
  | "FormValidationFeedback"
  | "FormatValidation"
  | "ActionFeedback"
  | "StateConsistency"
  | "NoServerError";

/**
 * How a candidate is exercised:
 * - emptySubmit: clear every field, then submit — checks Form Validation Feedback.
 * - validSubmit: fill every field with a plausible value, then submit —
 *   checks Action Feedback and State Consistency.
 * - invalidFormat: fill every field validly except fields with a known
 *   format (email, URL), which get a malformed value — checks Format
 *   Validation. Only generated when such a field is present and editable.
 *
 * Every strategy also checks NoServerError.
 */
export type Strategy = "emptySubmit" | "validSubmit" | "invalidFormat";

/**
 * How the interaction is committed:
 * - click: click the group's submit control.
 * - enter: press Enter in the last text field — for inputs that have no
 *   submit control at all (a todo entry box, a search box).
 */
export type SubmitMode = "click" | "enter";

/**
 * How the fields were grouped into one interaction:
 * - form: they sit inside a real <form> element.
 * - adjacent: no <form>, but the fields are immediately followed by a
 *   button in the same container (common in apps that never use <form>).
 * - single: one text field with no button next to it, committed with Enter.
 */
export type Grouping = "form" | "adjacent" | "single";

/** Enough information to find an element again with page.getByRole(role, { name }). */
export interface FieldTarget {
  role: string;
  label: string;
  inputType?: string;
  tag?: string;
  /** Disabled at detection time — the user can't edit it, so the tester doesn't either. */
  disabled?: boolean;
}

export interface ControlTarget {
  role: string;
  label: string;
}

/**
 * One candidate = one concrete interaction plus the contracts it is
 * checked against. The action is fully resolved at detection time
 * (README Section 4), so execution never has to guess what to do.
 */
export interface FormSubmitCandidate {
  id: string;
  kind: "formSubmit";
  route: string;
  session: SessionKind;
  strategy: Strategy;
  contracts: ContractName[];
  /** Human-readable name of the interaction, for reports. */
  formName: string;
  grouping: Grouping;
  submitMode: SubmitMode;
  fields: FieldTarget[];
  /** Present when submitMode is "click". */
  submit?: ControlTarget;
  /** One password field plus exactly one other text field — a login-style form. */
  isCredentialForm: boolean;
}

export type Candidate = FormSubmitCandidate;

/**
 * Controls found but not executed in Phase 2. Standalone buttons can be
 * destructive (delete, log out), and deciding which ones are safe and
 * what they should do is Semantic Contract Discovery's job (Phase 3).
 */
export interface DeferredControl {
  route: string;
  session: SessionKind;
  role: string;
  label: string;
  /**
   * "persistent" when the control sits in a navigation or banner landmark
   * and therefore repeats on every page (e.g. "Log out"); "page" otherwise.
   */
  region: "persistent" | "page";
  reason: string;
}
