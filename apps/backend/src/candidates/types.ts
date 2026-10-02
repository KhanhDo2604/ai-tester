export type SessionKind = "anonymous" | "authenticated";

export type ContractName =
  | "FormValidationFeedback"
  | "FormatValidation"
  | "ActionFeedback"
  | "StateConsistency"
  | "NoServerError"
  // Contracts for standalone actions (Phase 3):
  | "ActionEffect"
  | "ConfirmBeforeDestructive"
  | "DeletionEffective";

//How a candidate is exercised. Every strategy also checks NoServerError.
export type Strategy = "emptySubmit" | "validSubmit" | "invalidFormat";

//interaction
export type SubmitMode = "click" | "enter";

//How the fields were grouped into one interaction
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
  /** Headings of the page the control was found on — context for Semantic Contract Discovery. */
  pageHeadings: string[];
  reason: string;
}
