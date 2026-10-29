import { Candidate, FieldTarget } from "../candidates/types";
import { ScanConfig } from "../config/scanConfig";
import {
  Driver,
  errorText,
  RequestRecord,
  Session,
  SessionStorage,
} from "../driver/types";
import { stateKey } from "../explore/stateKey";
import { captureSignature, StateSignature } from "../state/signature";
import {
  formatKind,
  malformedValue,
  newRunId,
  valueForField,
} from "./fillValues";

export type { RequestRecord } from "../driver/types";

/** Everything observed while executing one candidate — the input to Contract Check. */
export interface Observation {
  candidate: Candidate;
  /** Signature before any field was touched. */
  before?: StateSignature;
  /** Signature after submitting (or after filling, when submit stayed disabled). */
  after?: StateSignature;
  /** Signature after reloading the state `after` was taken in (validSubmit only). */
  afterReload?: StateSignature;
  /**
   * The state the action led to is known not to survive a reload (the app
   * keeps it in memory only), so a reload comparison says nothing about it.
   */
  afterInMemoryOnly?: boolean;
  /** Whether the interaction was actually committed (clicked or Enter pressed). */
  submitted: boolean;
  /** Submit control was disabled at the moment of submitting. */
  submitDisabled: boolean;
  /** The platform's built-in input validation blocked submission. */
  nativeValidationBlocked: boolean;
  /** Messages of native alert / confirm dialogs that appeared. */
  nativeDialogs: string[];
  /** Data requests the interaction triggered, with their outcome. */
  requests: RequestRecord[];
  /** Run id the generated values were built from, so they can be derived again (e.g. a sign-up's login). */
  runId?: string;
  /** Set when the interaction itself could not be carried out. */
  error?: string;
}

export interface ExecutionContext {
  driver: Driver;
  config: ScanConfig;
  /** Keys of states that a reload does not return to (from exploration). */
  inMemoryStates?: Set<string>;
}

/**
 * Deterministic Execution — stage D. Runs one candidate in a fresh session,
 * so every execution starts from the same state and one candidate can never
 * leak state (a login, a half-filled form) into the next.
 */
export async function executeCandidate(
  ctx: ExecutionContext,
  candidate: Candidate,
  storage?: SessionStorage,
): Promise<Observation> {
  const observation: Observation = {
    candidate,
    submitted: false,
    submitDisabled: false,
    nativeValidationBlocked: false,
    nativeDialogs: [],
    requests: [],
  };

  const session = await ctx.driver.newSession(storage);
  // Only requests made while the interaction runs are recorded, so each one belongs to this candidate.
  const recorder = session.recordRequests();

  try {
    await session.restore(candidate.path);
    observation.before = await captureSignature(session);
    if (observation.before.route !== candidate.route) {
      throw new Error(
        `Could not reach ${candidate.route}; landed on ${observation.before.route}`,
      );
    }

    recorder.start();
    observation.runId = await fillForm(session, candidate, ctx.config);
    Object.assign(observation, await submitCandidate(session, candidate));
    observation.after = await captureSignature(session);
    observation.requests = recorder.stop();

    // State Consistency compares the post-action UI against the same state loaded fresh.
    if (candidate.strategy === "validSubmit" && observation.submitted) {
      observation.afterInMemoryOnly =
        ctx.inMemoryStates?.has(stateKey(observation.after)) ?? false;
      await session.reload();
      observation.afterReload = await captureSignature(session);
    }
  } catch (err) {
    observation.error = errorText(err);
  } finally {
    if (observation.requests.length === 0)
      observation.requests = recorder.stop();
    observation.nativeDialogs = session.takeDialogs();
    await session.close();
  }

  return observation;
}

export function valueFor(
  field: FieldTarget,
  candidate: Candidate,
  config: ScanConfig,
  runId: string,
): string {
  if (candidate.strategy === "emptySubmit") return "";
  const kind = formatKind(field);
  if (candidate.strategy === "invalidFormat" && kind)
    return malformedValue(kind, runId);
  return valueForField(field, candidate.isCredentialForm, config, runId);
}

/**
 * Commits the interaction the way a user would: clicking the submit
 * control, or pressing Enter in the last text field when there is none.
 * A disabled submit control is recorded, not clicked.
 */
export async function submitCandidate(
  session: Session,
  candidate: Candidate,
): Promise<
  Pick<Observation, "submitted" | "submitDisabled" | "nativeValidationBlocked">
> {
  if (candidate.submitMode === "enter" || !candidate.submit) {
    await session.pressEnter(candidate.fields[candidate.fields.length - 1]);
    return {
      submitted: true,
      submitDisabled: false,
      nativeValidationBlocked: false,
    };
  }

  if (await session.isDisabled(candidate.submit)) {
    return {
      submitted: false,
      submitDisabled: true,
      nativeValidationBlocked: false,
    };
  }

  const nativeValidationBlocked = await session.nativeValidationBlocks(
    candidate.submit,
  );
  await session.click(candidate.submit);
  return { submitted: true, submitDisabled: false, nativeValidationBlocked };
}

/**
 * Fills every field according to the strategy: emptySubmit clears
 * everything, validSubmit fills plausible values, invalidFormat fills a
 * malformed value into format fields (email, URL). Fields a user couldn't
 * edit are skipped.
 */
export async function fillForm(
  session: Session,
  candidate: Candidate,
  config: ScanConfig,
  runId: string = newRunId(),
): Promise<string> {
  const fillWithValues = candidate.strategy !== "emptySubmit";

  for (const field of candidate.fields) {
    if (field.role === "checkbox")
      await session.setChecked(field, fillWithValues);
    else if (field.tag === "select")
      await session.selectOption(field, fillWithValues ? 1 : 0);
    else await session.fill(field, valueFor(field, candidate, config, runId));
  }

  // The run id is embedded in every generated value, so whatever this submission creates can be found again.
  return runId;
}
