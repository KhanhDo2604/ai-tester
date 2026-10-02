import { ContractName } from "../candidates/types";
import { Observation } from "../execution/executeCandidate";
import { checkActionFeedback } from "./actionFeedback";
import { checkFormatValidation } from "./formatValidation";
import { checkFormValidationFeedback } from "./formValidationFeedback";
import { checkNoServerError } from "./noServerError";
import { checkStateConsistency } from "./stateConsistency";
import { ContractCheck, ContractResult } from "./types";

/** Contracts for form candidates. Standalone actions use contracts/actionContracts.ts instead. */
const CHECKS: Partial<Record<ContractName, ContractCheck>> = {
  FormValidationFeedback: checkFormValidationFeedback,
  FormatValidation: checkFormatValidation,
  ActionFeedback: checkActionFeedback,
  StateConsistency: checkStateConsistency,
  NoServerError: checkNoServerError,
};

/** Contract Check — README Section 7. Runs every contract the candidate carries. */
export function checkContracts(observation: Observation): ContractResult[] {
  const { candidate } = observation;
  return candidate.contracts.map((contract) => {
    const check = CHECKS[contract];
    if (!check)
      throw new Error(
        `No form-candidate check registered for contract "${contract}"`,
      );
    return {
      contract,
      candidateId: candidate.id,
      route: candidate.route,
      ...check(observation),
    };
  });
}
