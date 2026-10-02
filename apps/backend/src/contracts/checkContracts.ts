import { ContractName } from "../candidates/types";
import { Observation } from "../execution/executeCandidate";
import { checkActionFeedback } from "./actionFeedback";
import { checkFormatValidation } from "./formatValidation";
import { checkFormValidationFeedback } from "./formValidationFeedback";
import { checkNoServerError } from "./noServerError";
import { checkStateConsistency } from "./stateConsistency";
import { ContractCheck, ContractResult } from "./types";

const CHECKS: Record<ContractName, ContractCheck> = {
  FormValidationFeedback: checkFormValidationFeedback,
  FormatValidation: checkFormatValidation,
  ActionFeedback: checkActionFeedback,
  StateConsistency: checkStateConsistency,
  NoServerError: checkNoServerError,
};

/** Contract Check — README Section 7. Runs every contract the candidate carries. */
export function checkContracts(observation: Observation): ContractResult[] {
  const { candidate } = observation;
  return candidate.contracts.map((contract) => ({
    contract,
    candidateId: candidate.id,
    route: candidate.route,
    ...CHECKS[contract](observation),
  }));
}
