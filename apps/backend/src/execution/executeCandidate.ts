import { Browser, BrowserContext, Page } from "playwright";
import { Candidate, FieldTarget } from "../candidates/types";
import { ScanConfig } from "../config/scanConfig";
import { captureSignature, StateSignature } from "../state/signature";
import {
  formatKind,
  malformedValue,
  newRunId,
  valueForField,
} from "./fillValues";
import { trackNetwork } from "./network";

type AriaRole = Parameters<Page["getByRole"]>[0];
export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Element actions (fill, click) fail fast; a missing element shouldn't stall a scan. */
export const ACTION_TIMEOUT_MS = 5000;

/**
 * Navigation gets much longer: a remote app on a cold-starting host can
 * take well over 10 seconds to answer its first request.
 */
export const NAVIGATION_TIMEOUT_MS = 30000;

/**
 * One fetch/XHR request made while the interaction ran. `status` is the
 * HTTP status; `failure` is set instead when no response arrived at all
 * (connection refused, reset, DNS failure).
 */
export interface RequestRecord {
  method: string;
  /** Path and query only — the origin is the same for every request worth reporting. */
  url: string;
  status?: number;
  failure?: string;
}

/** Everything observed while executing one candidate — the input to Contract Check. */
export interface Observation {
  candidate: Candidate;
  /** Signature before any field was touched. */
  before?: StateSignature;
  /** Signature after submitting (or after filling, when submit stayed disabled). */
  after?: StateSignature;
  /** Signature after reloading the page that `after` was taken on (validSubmit only). */
  afterReload?: StateSignature;
  /** Whether the interaction was actually committed (clicked or Enter pressed). */
  submitted: boolean;
  /** Submit control was disabled at the moment of submitting. */
  submitDisabled: boolean;
  /** The browser's built-in constraint validation (required, type=email, ...) blocked submission. */
  nativeValidationBlocked: boolean;
  /** Messages of native alert / confirm dialogs that appeared. */
  nativeDialogs: string[];
  /** Data requests (fetch/XHR) the interaction triggered, with their outcome. */
  requests: RequestRecord[];
  /** Set when the interaction itself could not be carried out. */
  error?: string;
}

/** Creates a page with the timeouts and network tracking every scan step uses. */
export async function openPage(
  browser: Browser,
  config: ScanConfig,
  storageState?: StorageState,
) {
  const context = await browser.newContext({
    baseURL: config.baseUrl,
    storageState,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  const network = trackNetwork(page);
  return { context, page, network };
}

/**
 * Navigates without waiting for the "load" event. "load" waits for every
 * image, font and third-party script, so one slow external resource can
 * time out a page that is fully usable. DOMContentLoaded plus the network
 * tracker's settle (which has its own upper bound) is enough.
 */
export async function navigate(page: Page, path: string) {
  return page.goto(path, { waitUntil: "domcontentloaded" });
}

/**
 * Deterministic Execution — README pipeline stage D. Runs one candidate in
 * a fresh browser context, so every execution starts from the same state
 * and one candidate can never leak state (a login, a half-filled form)
 * into the next.
 */
export async function executeCandidate(
  browser: Browser,
  config: ScanConfig,
  candidate: Candidate,
  storageState?: StorageState,
): Promise<Observation> {
  const observation: Observation = {
    candidate,
    submitted: false,
    submitDisabled: false,
    nativeValidationBlocked: false,
    nativeDialogs: [],
    requests: [],
  };

  const { context, page, network } = await openPage(
    browser,
    config,
    storageState,
  );
  page.on("dialog", async (dialog) => {
    observation.nativeDialogs.push(dialog.message());
    await dialog.accept().catch(() => {});
  });

  // Requests are recorded only while the interaction runs (fill → submit →
  // settle), not during the initial page load or the later reload, so every
  // recorded request can be attributed to this candidate's action.
  let recording = false;
  page.on("response", (response) => {
    const request = response.request();
    if (!recording || !DATA_REQUEST_TYPES.has(request.resourceType())) return;
    observation.requests.push({
      method: request.method(),
      url: pathOf(request.url()),
      status: response.status(),
    });
  });
  page.on("requestfailed", (request) => {
    if (!recording || !DATA_REQUEST_TYPES.has(request.resourceType())) return;
    const failure = request.failure()?.errorText ?? "unknown error";
    // ERR_ABORTED means the browser cancelled the request itself, almost
    // always because the page navigated away — not a server problem.
    if (failure.includes("ERR_ABORTED")) return;
    observation.requests.push({
      method: request.method(),
      url: pathOf(request.url()),
      failure,
    });
  });

  try {
    await navigate(page, candidate.route);
    observation.before = await captureSignature(page, network);
    if (observation.before.route !== candidate.route) {
      throw new Error(
        `Could not reach ${candidate.route}; landed on ${observation.before.route}`,
      );
    }

    recording = true;
    await fillForm(page, candidate, config);
    Object.assign(observation, await submitCandidate(page, candidate));
    observation.after = await captureSignature(page, network);
    recording = false;

    // State Consistency needs to know what the same page looks like when
    // loaded fresh, so the post-action UI can be compared against it.
    if (candidate.strategy === "validSubmit" && observation.submitted) {
      await page.reload({ waitUntil: "domcontentloaded" });
      observation.afterReload = await captureSignature(page, network);
    }
  } catch (err) {
    observation.error =
      err instanceof Error ? err.message.split("\n")[0] : String(err);
  } finally {
    recording = false;
    await context.close();
  }

  return observation;
}

function valueFor(
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

/** Requests that carry application data, as opposed to page assets. */
const DATA_REQUEST_TYPES = new Set(["fetch", "xhr"]);

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function locateField(page: Page, field: FieldTarget) {
  return page
    .getByRole(field.role as AriaRole, { name: field.label, exact: true })
    .first();
}

/**
 * Commits the interaction the way a user would: clicking the submit
 * control, or pressing Enter in the last text field when there is none.
 * A disabled submit control is recorded, not clicked.
 */
export async function submitCandidate(
  page: Page,
  candidate: Candidate,
): Promise<
  Pick<Observation, "submitted" | "submitDisabled" | "nativeValidationBlocked">
> {
  if (candidate.submitMode === "enter" || !candidate.submit) {
    const lastField = candidate.fields[candidate.fields.length - 1];
    await locateField(page, lastField).press("Enter");
    return {
      submitted: true,
      submitDisabled: false,
      nativeValidationBlocked: false,
    };
  }

  const submit = page
    .getByRole(candidate.submit.role as AriaRole, {
      name: candidate.submit.label,
      exact: true,
    })
    .first();
  if (await submit.isDisabled()) {
    return {
      submitted: false,
      submitDisabled: true,
      nativeValidationBlocked: false,
    };
  }

  const nativeValidationBlocked = await submit.evaluate((el: any) => {
    const form = el.form;
    return form ? !form.noValidate && !form.checkValidity() : false;
  });
  await submit.click();
  return { submitted: true, submitDisabled: false, nativeValidationBlocked };
}

/**
 * Fills every field of the candidate according to its strategy:
 * emptySubmit clears everything, validSubmit fills plausible values, and
 * invalidFormat fills plausible values except for format fields (email,
 * URL), which get a malformed one. Fields that are disabled or read-only
 * are skipped, since a user couldn't change them either.
 */
export async function fillForm(
  page: Page,
  candidate: Candidate,
  config: ScanConfig,
): Promise<void> {
  const runId = newRunId();
  const fillWithValues = candidate.strategy !== "emptySubmit";

  for (const field of candidate.fields) {
    const locator = locateField(page, field);
    if (!(await locator.isEditable().catch(() => false))) continue;

    if (field.role === "checkbox") {
      if (fillWithValues) await locator.check();
      else await locator.uncheck();
      continue;
    }

    if (field.tag === "select") {
      await locator
        .selectOption({ index: fillWithValues ? 1 : 0 })
        .catch(() => {});
      continue;
    }

    await locator.fill(valueFor(field, candidate, config, runId));
  }
}
