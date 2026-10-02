import { ContractName } from "../candidates/types";
import { EvidenceLevel, Finding } from "./types";

const STANDARDS: Partial<Record<ContractName, string>> = {
  NoServerError:
    "RFC 9110 §15.6: a 5xx status means the server failed to fulfil a valid request",
};

export const LEVEL_LABELS: Record<EvidenceLevel, string> = {
  4: "Confirmed bug (named standard)",
  3: "Confirmed bug",
  2: "Potential issue",
  1: "Potential improvement",
  0: "Discarded",
};

/**
 * Evidence Ladder — README §9. The level comes from how the finding was
 * established (contract type, reproduction, standard), never from model
 * confidence, which is kept only as context.
 */
export function assignLevel(f: Finding): void {
  const reproduced = f.reproduced === true;

  if (f.source === "discovered") {
    f.kind = "improvement";
    f.level = reproduced ? 1 : 0;
    f.levelReason = reproduced
      ? "the expectation was proposed by the model; the behaviour was observed on both runs"
      : "model-proposed expectation, and the behaviour did not repeat";
    return;
  }

  f.kind = "bug";

  if (f.source === "judged") {
    f.level = reproduced ? 2 : 0;
    f.levelReason = reproduced
      ? "the outcome was ambiguous to the rules and judged a violation by the model; it repeated on a second run"
      : "judged a violation by the model, but the behaviour did not repeat";
    return;
  }

  if (!reproduced) {
    f.level = 2;
    f.levelReason =
      "a predefined contract was violated once, but not on a second run";
    return;
  }

  f.standard = f.contracts.map((c) => STANDARDS[c]).find(Boolean);
  f.level = f.standard ? 4 : 3;
  f.levelReason = f.standard
    ? "a predefined contract was violated on both runs, and the behaviour breaks a named standard"
    : "a predefined contract was violated on both runs";
}
