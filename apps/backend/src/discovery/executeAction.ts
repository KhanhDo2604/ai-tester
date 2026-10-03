import { Browser, Page } from "playwright";
import { Candidate } from "../candidates/types";
import { ScanConfig } from "../config/scanConfig";
import { buildUISemanticGraph } from "../graph/buildGraph";
import { UISemanticGraphNode } from "../graph/types";
import { cleanText, walk } from "../graph/walk";
import {
  createOwnInstance,
  OwnInstance,
  rankCreators,
} from "../entity/ownInstance";
import {
  navigate,
  openPage,
  recordDataRequests,
  RequestRecord,
  StorageState,
} from "../execution/executeCandidate";
import { NetworkTracker } from "../execution/network";
import { captureSignature, StateSignature } from "../state/signature";
import { ClassifiedAction } from "./types";

type AriaRole = Parameters<Page["getByRole"]>[0];

export interface ActionObservation {
  action: ClassifiedAction;
  executed: boolean;
  /** Why the action was not executed (no classification, unsafe category, no own instance). */
  skipReason?: string;
  instance?: OwnInstance;
  /** On the instance's page, before clicking. */
  before?: StateSignature;
  /** After clicking (and confirming, if a confirmation was shown). */
  after?: StateSignature;
  /** Data requests made by the click and any confirmation. */
  requests: RequestRecord[];
  nativeDialogs: string[];
  /** A native confirm/alert or an in-page dialog appeared after the click. */
  confirmationShown: boolean;
  /** How the confirmation was answered, when one was shown. */
  confirmationAnswer?: string;
  /** Destructive actions only: the instance's page opened again afterwards. */
  revisit?: {
    signature: StateSignature;
    markerPresent: boolean;
    requests: RequestRecord[];
  };
  error?: string;
}

/** Categories that change data and are therefore only ever run against an own instance. */
const EXECUTABLE_CATEGORIES = new Set(["destructive", "state-change"]);

const SKIP_REASONS: Record<string, string> = {
  session:
    "ends or switches the session — clicking it would only end the scan's own login",
  navigation:
    "navigation only — covered by the crawl, not executed as an action",
  export: "export/download — not checked in this version",
  unknown: "the label doesn't say what it does — not executed on a guess",
};

/**
 * Executes one classified standalone action, safely:
 *
 * 1. Only destructive and state-changing actions are executed at all.
 * 2. They are executed only on a record the tester created itself (an
 *    "own instance"), on the same page shape the control was found on.
 *    Existing data is never touched; if no own instance can be created,
 *    the action is skipped and the reason reported.
 * 3. Each action gets a fresh instance in a fresh browser context, so
 *    deleting one record can't interfere with completing another.
 *
 * A consequence worth noting: because every action runs on a throwaway
 * record, a wrong classification by the model is cheap. The worst case is
 * an action clicked on the tester's own record.
 */
export async function executeAction(
  browser: Browser,
  config: ScanConfig,
  action: ClassifiedAction,
  candidates: Candidate[],
  storageState?: StorageState,
): Promise<ActionObservation> {
  const observation: ActionObservation = {
    action,
    executed: false,
    requests: [],
    nativeDialogs: [],
    confirmationShown: false,
  };

  if (!action.contract) {
    observation.skipReason = `not classified: ${action.classificationError ?? "unknown reason"}`;
    return observation;
  }
  if (action.contract.deletesCurrentAccount) {
    observation.skipReason =
      "deletes the signed-in account; used only at the end of a scan to remove an account the tester registered itself";
    return observation;
  }
  if (!EXECUTABLE_CATEGORIES.has(action.contract.category)) {
    observation.skipReason =
      SKIP_REASONS[action.contract.category] ?? "not executable";
    return observation;
  }
  if (!action.routePattern.includes(":id")) {
    observation.skipReason =
      "acts on a page that isn't about one specific record, so it would change existing data";
    return observation;
  }

  const { context, page, network } = await openPage(
    browser,
    config,
    storageState,
  );
  page.on("dialog", async (dialog) => {
    observation.nativeDialogs.push(dialog.message());
    await dialog.accept().catch(() => {});
  });
  const recorder = recordDataRequests(page);

  try {
    // Step 1 — create an own instance on the right page shape.
    const attempts: string[] = [];
    for (const creator of rankCreators(
      candidates,
      action.routePattern,
      action.control.session,
    )) {
      const result = await createOwnInstance(
        page,
        network,
        config,
        creator,
        action.routePattern,
      );
      if ("failure" in result) {
        attempts.push(result.failure);
        continue;
      }
      observation.instance = result;
      break;
    }
    if (!observation.instance) {
      observation.skipReason =
        `no own record of shape ${action.routePattern} could be created` +
        (attempts.length
          ? ` (${attempts.join("; ")})`
          : " (no suitable creation form found)");
      return observation;
    }
    // Dialogs shown while creating the instance are not part of the action.
    observation.nativeDialogs = [];

    // Step 2 — act on it.
    await navigate(page, observation.instance.path);
    observation.before = await captureSignature(page, network);

    recorder.start();
    const control = page
      .getByRole(action.control.role as AriaRole, {
        name: action.control.label,
        exact: true,
      })
      .first();
    await control.click();
    observation.executed = true;
    await network.settle();

    await answerConfirmation(page, network, observation);

    observation.after = await captureSignature(page, network);
    observation.requests = recorder.stop();

    // Step 3 — for deletions, open the record's page again to see whether it is really gone.
    if (action.contract.category === "destructive") {
      recorder.start();
      await navigate(page, observation.instance.path);
      const signature = await captureSignature(page, network);
      observation.revisit = {
        signature,
        markerPresent: signatureContains(
          signature,
          observation.instance.marker,
        ),
        requests: recorder.stop(),
      };
    }
  } catch (err) {
    observation.error =
      err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (observation.requests.length === 0)
      observation.requests = recorder.stop();
  } finally {
    await context.close();
  }

  return observation;
}

/**
 * Detects a confirmation step and answers it with "yes", so the action can
 * be observed to completion.
 *
 * Native confirm() dialogs are accepted automatically by the page's
 * dialog handler. An in-page dialog (role dialog / alertdialog) is
 * answered by clicking the button inside it that repeats the action's
 * verb ("Delete" for "Delete task") or reads as a generic yes.
 */
async function answerConfirmation(
  page: Page,
  network: NetworkTracker,
  observation: ActionObservation,
): Promise<void> {
  const result = await confirmIfAsked(
    page,
    network,
    observation.action.control.label,
    observation.before?.dialogs ?? [],
    observation.nativeDialogs,
  );
  observation.confirmationShown = result.shown;
  observation.confirmationAnswer = result.answer;
}

/**
 * The confirmation logic itself, independent of any observation, so other
 * steps (cleaning up own records) answer confirmations the same way.
 */
export async function confirmIfAsked(
  page: Page,
  network: NetworkTracker,
  controlLabel: string,
  dialogsBeforeClick: string[],
  nativeDialogs: string[],
): Promise<{ shown: boolean; answer?: string }> {
  if (nativeDialogs.length > 0) {
    return {
      shown: true,
      answer: `accepted browser dialog "${nativeDialogs[0]}"`,
    };
  }

  const graph = await buildUISemanticGraph(page);
  const dialogsBefore = new Set(dialogsBeforeClick);
  const newDialogs: UISemanticGraphNode[] = [];
  walk(graph.root, (node) => {
    if (
      node.type === "dialog" &&
      !dialogsBefore.has(cleanText(node.label) || "(unnamed dialog)")
    )
      newDialogs.push(node);
  });
  if (newDialogs.length === 0) return { shown: false };

  const verb = cleanText(controlLabel).split(" ")[0]?.toLowerCase() ?? "";
  let confirmLabel: string | undefined;
  for (const dialog of newDialogs) {
    walk(dialog, (node) => {
      if (confirmLabel || node.type !== "button" || !node.label) return;
      const label = cleanText(node.label).toLowerCase();
      if (
        (verb && label.startsWith(verb)) ||
        /^(yes|ok|confirm|continue)\b/.test(label)
      )
        confirmLabel = node.label;
    });
  }

  if (!confirmLabel)
    return {
      shown: true,
      answer: "a dialog appeared, but no confirming button could be identified",
    };
  await page
    .getByRole("button", { name: confirmLabel, exact: true })
    .last()
    .click();
  await network.settle();
  return {
    shown: true,
    answer: `clicked "${cleanText(confirmLabel)}" in the dialog`,
  };
}

export function signatureContains(
  signature: StateSignature,
  marker: string,
): boolean {
  return [
    ...signature.texts,
    ...signature.headings,
    ...signature.alerts,
    ...signature.buttons.map((b) => b.label),
  ].some((text) => text.includes(marker));
}
