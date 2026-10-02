import { DeferredControl } from "../candidates/types";

export const ACTION_CATEGORIES = [
  "destructive",
  "state-change",
  "navigation",
  "session",
  "export",
  "unknown",
] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

/**
 * A hypothesis contract — README Section 5. Produced by the LLM from one
 * control's label and context, never treated as fact: it only decides
 * how the control is exercised and which discovered expectation is
 * checked, and everything it leads to still has to be observed.
 */
export interface DiscoveredContract {
  category: ActionCategory;
  /** One sentence: what a reasonable user expects after clicking. */
  expectation: string;
  /** Whether a reasonable user would expect to confirm before it takes effect. */
  requiresConfirmation: boolean;
}

/** A standalone control on a page shape (route pattern), deduplicated across concrete pages. */
export interface ActionTarget {
  control: DeferredControl;
  /** e.g. "/tasks/:id" — the page shape the control was found on. */
  routePattern: string;
}

export type ClassifiedAction = ActionTarget & {
  /** Undefined when no LLM is available or the call failed. */
  contract?: DiscoveredContract;
  classificationError?: string;
};
