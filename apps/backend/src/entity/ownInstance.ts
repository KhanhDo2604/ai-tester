import { Candidate, SessionKind } from "../candidates/types";
import { ScanConfig } from "../config/scanConfig";
import { Session } from "../driver/types";
import { routePattern } from "../explore/stateKey";
import { textContent, walk } from "../graph/walk";
import { fillForm, submitCandidate } from "../execution/executeCandidate";

/** A record the tester created itself, so acting on it can never touch existing data. */
export interface OwnInstance {
  /** Path of the record's own page, e.g. /tasks/57. */
  path: string;
  /** The run id embedded in the record's text — how the tester recognises it. */
  marker: string;
  /** Which form created it. */
  createdBy: string;
}

const MAX_CREATOR_ATTEMPTS = 3;

/** How long a newly created record may take to appear before the creator is considered not to have produced one. */
const RECORD_APPEAR_TIMEOUT_MS = 20000;

/**
 * Picks the forms most likely to create a record of the given page shape.
 *
 * Heuristic, but app-agnostic: in almost every web app the form that
 * creates a record lives next to the pages that show it — /tasks/new
 * creates what /tasks/:id shows, /projects/create what /projects/:id
 * shows. So forms whose route shares the first path segment with the
 * pattern are tried first. The others follow, in case the app keeps its
 * create form elsewhere (a modal on a list page, a dashboard widget).
 *
 * Only validSubmit candidates of the same session qualify (an anonymous
 * sign-up form must never be used to create records for a logged-in
 * page), and credential forms never do (logging in creates nothing).
 */
export function rankCreators(
  candidates: Candidate[],
  pattern: string,
  session: SessionKind,
): Candidate[] {
  const section = pattern.split("/")[1] ?? "";
  const eligible = candidates.filter(
    (c) =>
      c.strategy === "validSubmit" &&
      c.submitMode === "click" &&
      c.session === session &&
      !c.isCredentialForm &&
      c.fields.some((f) => f.role === "textbox" && f.inputType !== "password"),
  );
  const sameSection = eligible.filter((c) => c.route.split("/")[1] === section);
  const others = eligible.filter((c) => c.route.split("/")[1] !== section);
  return [...sameSection, ...others].slice(0, MAX_CREATOR_ATTEMPTS);
}

/**
 * Submits a creation form with marker-tagged values, then looks for the
 * page of what was just created. Two ways to find it, both generic:
 * - the app redirected straight to the new record's page (the current
 *   path matches the pattern and the page shows the marker), or
 * - the app went to a page that links to it (a link whose text contains
 *   the marker and whose target matches the pattern).
 *
 * Returns the instance, or a reason it couldn't be found.
 */
export async function createOwnInstance(
  session: Session,
  config: ScanConfig,
  creator: Candidate,
  pattern: string,
): Promise<OwnInstance | { failure: string }> {
  await session.restore(creator.path);
  await session.settle();
  const marker = await fillForm(session, creator, config);
  const submitted = await submitCandidate(session, creator);
  if (!submitted.submitted)
    return {
      failure: `${creator.route} "${creator.formName}": submit stayed disabled`,
    };

  // Wait for the new record itself to show up, not just for the network to
  // go quiet. The network wait has an upper bound, and a slow list endpoint
  // can outlast it — the page is then captured while the list is still
  // loading, and the record looks missing when it is only late. Waiting for
  // the marker text covers both outcomes (a list linking to the record, or
  // the record's own page) and returns as soon as either appears.
  await session.waitForText(marker, RECORD_APPEAR_TIMEOUT_MS);
  await session.settle();

  const graph = await session.observe();
  const landedOn = session.location();
  const createdBy = `${creator.route} "${creator.formName}"`;

  if (
    routePattern(landedOn) === pattern &&
    textContent(graph.root).includes(marker)
  ) {
    return { path: landedOn, marker, createdBy };
  }

  let found: string | undefined;
  walk(graph.root, (node) => {
    if (found || node.type !== "link" || !node.domExtra?.href) return;
    if (!(node.label ?? "").includes(marker)) return;
    const path = new URL(node.domExtra.href).pathname;
    if (routePattern(path) === pattern) found = path;
  });
  if (found) return { path: found, marker, createdBy };

  return {
    failure: `${createdBy}: landed on ${landedOn}, but no link to a ${pattern} page showing the new record was found`,
  };
}
