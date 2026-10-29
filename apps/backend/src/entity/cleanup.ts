import { errorText, SessionStorage } from "../driver/types";
import {
  ActionObservation,
  confirmIfAsked,
  signatureContains,
} from "../discovery/executeAction";
import { ExecutionContext } from "../execution/executeCandidate";
import { captureSignature } from "../state/signature";
import { OwnInstance } from "./ownInstance";

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
  ctx: ExecutionContext,
  observations: ActionObservation[],
  storage?: SessionStorage,
  /** Own records created outside actions (e.g. by the list-scaling check). */
  extraRecords: { instance: OwnInstance; pattern: string }[] = [],
): Promise<CleanupResult[]> {
  const provenDeletions = observations.filter(
    (o) =>
      o.executed &&
      o.action.contract?.category === "destructive" &&
      o.revisit &&
      !o.revisit.markerPresent,
  );
  const leftovers = [
    ...observations
      .filter((o) => o.instance && !(o.revisit && !o.revisit.markerPresent))
      .map((o) => ({ instance: o.instance!, pattern: o.action.routePattern })),
    ...extraRecords,
  ];

  const results: CleanupResult[] = [];
  if (leftovers.length === 0) return results;

  const session = await ctx.driver.newSession(storage);

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
        await session.open(instance.path);
        const before = await captureSignature(session);
        if (!signatureContains(before, instance.marker)) {
          results.push({
            instance,
            removed: false,
            note: "page doesn't show this scan's marker — not touched",
          });
          continue;
        }

        session.takeDialogs();
        const label = deletion.action.control.label;
        await session.click(deletion.action.control);
        await session.settle();
        await confirmIfAsked(
          session,
          label,
          before.dialogs,
          session.takeDialogs(),
        );

        await session.open(instance.path);
        const after = await captureSignature(session);
        const removed = !signatureContains(after, instance.marker);
        results.push({
          instance,
          removed,
          note: removed
            ? `removed with "${label}"`
            : `"${label}" did not remove it`,
        });
      } catch (err) {
        results.push({ instance, removed: false, note: errorText(err) });
      }
    }
  } finally {
    await session.close();
  }

  return results;
}
