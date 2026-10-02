import { Browser, Page } from "playwright";
import { ScanConfig } from "../config/scanConfig";
import {
  ActionObservation,
  confirmIfAsked,
  signatureContains,
} from "../discovery/executeAction";
import {
  navigate,
  openPage,
  StorageState,
} from "../execution/executeCandidate";
import { captureSignature } from "../state/signature";
import { OwnInstance } from "./ownInstance";

type AriaRole = Parameters<Page["getByRole"]>[0];

export interface CleanupResult {
  instance: OwnInstance;
  removed: boolean;
  note: string;
}

/**
 * Removes the records the tester created that are still there after
 * Phase 3 — typically the ones used for state-changing actions such as
 * "Mark complete", which don't remove their record.
 *
 * Only a deletion that has already been observed to work is used: a
 * destructive action on the same page shape whose DeletionEffective check
 * passed on an own record during this scan. If none did, nothing is
 * cleaned up and the leftovers are reported, rather than guessing which
 * control deletes.
 *
 * Safety check before every click: the page must show this scan's run
 * marker. A record the tester didn't create can never be deleted here,
 * even if a path were wrong.
 */
export async function cleanUpOwnRecords(
  browser: Browser,
  config: ScanConfig,
  observations: ActionObservation[],
  storageState?: StorageState,
): Promise<CleanupResult[]> {
  const provenDeletions = observations.filter(
    (o) =>
      o.executed &&
      o.action.contract?.category === "destructive" &&
      o.revisit &&
      !o.revisit.markerPresent,
  );
  const leftovers = observations
    .filter((o) => o.instance && !(o.revisit && !o.revisit.markerPresent))
    .map((o) => ({ instance: o.instance!, pattern: o.action.routePattern }));

  const results: CleanupResult[] = [];
  if (leftovers.length === 0) return results;

  const { context, page, network } = await openPage(
    browser,
    config,
    storageState,
  );
  const nativeDialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    nativeDialogs.push(dialog.message());
    await dialog.accept().catch(() => {});
  });

  try {
    for (const { instance, pattern } of leftovers) {
      const deletion = provenDeletions.find(
        (o) => o.action.routePattern === pattern,
      );
      if (!deletion) {
        results.push({
          instance,
          removed: false,
          note: `no deletion on ${pattern} was proven to work during this scan`,
        });
        continue;
      }

      try {
        await navigate(page, instance.path);
        const before = await captureSignature(page, network);
        if (!signatureContains(before, instance.marker)) {
          results.push({
            instance,
            removed: false,
            note: "page doesn't show this scan's marker — not touched",
          });
          continue;
        }

        nativeDialogs.length = 0;
        const label = deletion.action.control.label;
        await page
          .getByRole(deletion.action.control.role as AriaRole, {
            name: label,
            exact: true,
          })
          .first()
          .click();
        await network.settle();
        await confirmIfAsked(
          page,
          network,
          label,
          before.dialogs,
          nativeDialogs,
        );

        await navigate(page, instance.path);
        const after = await captureSignature(page, network);
        const removed = !signatureContains(after, instance.marker);
        results.push({
          instance,
          removed,
          note: removed
            ? `removed with "${label}"`
            : `"${label}" did not remove it`,
        });
      } catch (err) {
        results.push({
          instance,
          removed: false,
          note: err instanceof Error ? err.message.split("\n")[0] : String(err),
        });
      }
    }
  } finally {
    await context.close();
  }

  return results;
}
