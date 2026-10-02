import { Browser } from "playwright";
import { Candidate } from "../candidates/types";
import { ScanConfig } from "../config/scanConfig";
import { checkActionContracts } from "../contracts/actionContracts";
import { checkContracts } from "../contracts/checkContracts";
import { ContractResult } from "../contracts/types";
import { ActionObservation, executeAction } from "../discovery/executeAction";
import { executeCandidate, StorageState } from "../execution/executeCandidate";
import { Finding } from "./types";

export interface RunContext {
  browser: Browser;
  config: ScanConfig;
  candidates: Candidate[];
  storageState?: StorageState;
}

export interface Reproduction {
  reproduced: boolean;
  note: string;
  /** Present when the rerun created an own record that may need cleaning up. */
  actionObservation?: ActionObservation;
}

/** Runs the finding's first subject again, from a fresh context, and checks the same contracts. */
export async function reproduce(
  ctx: RunContext,
  finding: Finding,
): Promise<Reproduction> {
  const subject = finding.results[0].subject;
  let results: ContractResult[];
  let actionObservation: ActionObservation | undefined;

  if (subject.kind === "form") {
    const storage =
      subject.candidate.session === "authenticated"
        ? ctx.storageState
        : undefined;
    results = checkContracts(
      await executeCandidate(
        ctx.browser,
        ctx.config,
        subject.candidate,
        storage,
      ),
    );
  } else {
    const storage =
      subject.action.control.session === "authenticated"
        ? ctx.storageState
        : undefined;
    actionObservation = await executeAction(
      ctx.browser,
      ctx.config,
      subject.action,
      ctx.candidates,
      storage,
    );
    results = checkActionContracts(actionObservation);
  }

  const again = results.filter((r) => finding.contracts.includes(r.contract));
  // A judged finding came from AMBIGUOUS; the same ambiguous outcome again counts as the behaviour repeating.
  const repeats = (r: ContractResult) =>
    r.verdict === "VIOLATION" ||
    (finding.source === "judged" && r.verdict === "AMBIGUOUS");
  const reproduced = again.some(repeats);

  return {
    reproduced,
    note: reproduced
      ? "reproduced on a second run"
      : `not reproduced on a second run (${again.map((r) => `${r.contract}: ${r.verdict}`).join(", ") || "not checked"})`,
    actionObservation,
  };
}
