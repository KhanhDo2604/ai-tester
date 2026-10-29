import { DeferredControl } from "../candidates/types";
import { locationOf } from "../driver/types";
import { routePattern } from "../explore/stateKey";
import { ActionTarget } from "./types";

/**
 * Turns the deferred controls found on every crawled page into one target
 * per distinct control per page shape. "Delete task" on /tasks/1 and on
 * /tasks/2 is one target on /tasks/:id; "Log out" in the navigation is one
 * target however many pages it appears on. Each target costs at most one
 * LLM call, so this deduplication is what keeps discovery's cost
 * proportional to the app's distinct controls, not to its page count.
 */
export function buildActionTargets(
  deferred: DeferredControl[],
): ActionTarget[] {
  const targets = new Map<string, ActionTarget>();
  for (const control of deferred) {
    const pattern = routePattern(control.route);
    const key =
      control.region === "persistent"
        ? `persistent::${control.session}::${control.role}::${control.label}`
        : `${control.session}::${control.path.steps.length ? locationOf(control.path) : pattern}::${control.role}::${control.label}`;
    if (!targets.has(key)) targets.set(key, { control, routePattern: pattern });
  }
  return [...targets.values()];
}
