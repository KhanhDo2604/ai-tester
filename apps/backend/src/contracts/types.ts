import { ContractName } from "../candidates/types";
import { Observation } from "../execution/executeCandidate";

/**
 * README Section 7. VIOLATION and SATISFIED go straight to the Evidence
 * Ladder (Phase 4); AMBIGUOUS is what gets routed to LLM Semantic
 * Judgment; NOT_APPLICABLE means the observation can't say anything about
 * this contract (e.g. the action never ran).
 */
export type Verdict =
  "SATISFIED" | "VIOLATION" | "AMBIGUOUS" | "NOT_APPLICABLE";

export interface ContractResult {
  contract: ContractName;
  candidateId: string;
  route: string;
  verdict: Verdict;
  /** Concrete, human-readable facts from the before/after delta that support the verdict. */
  evidence: string[];
  /**
   * "predefined" contracts have a hand-written comparison function.
   * "discovered" ones come from an LLM hypothesis (README Section 5), so a
   * violation of one is a weaker claim — the Evidence Ladder (Phase 4)
   * ranks it lower, and the report presents it as a potential issue or
   * improvement rather than a confirmed bug. Absent means "predefined".
   */
  source?: "predefined" | "discovered";
}

export type ContractCheck = (
  observation: Observation,
) => Omit<ContractResult, "contract" | "candidateId" | "route">;
