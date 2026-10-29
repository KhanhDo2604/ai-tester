import { detectCandidates } from "../candidates/detectCandidates";
import { SessionKind } from "../candidates/types";
import { describeRequests } from "../contracts/noServerError";
import { DEFAULT_EXCLUDE_LINK_PATTERN, ScanConfig } from "../config/scanConfig";
import {
  Driver,
  ElementTarget,
  errorText,
  locationOf,
  SessionStorage,
  StatePath,
} from "../driver/types";
import { fillForm, submitCandidate } from "../execution/executeCandidate";
import { UISemanticGraph } from "../graph/types";
import { walk } from "../graph/walk";
import { signatureFromGraph } from "../state/signature";
import { routePattern, stateKey } from "./stateKey";

/** One node of the state-flow graph. */
export interface DiscoveredState {
  graph: UISemanticGraph;
  session: SessionKind;
  path: StatePath;
  key: string;
}

/** A state the explorer tried to reach but couldn't, or chose not to. Reported, never dropped. */
export interface ExploreFailure {
  location: string;
  session: SessionKind;
  error: string;
}

export interface ExploreResult {
  states: DiscoveredState[];
  failures: ExploreFailure[];
  /** Keys of states a reload does not return to: the app keeps them in memory only. */
  inMemoryStates: Set<string>;
  /** Controls that were clicked as navigation (navigationId), so they need no classification. */
  navigation: Set<string>;
}

/** Identity of a navigation control across screens, with numbers ignored. */
export function navigationId(target: { role: string; label: string }): string {
  return `${target.role}::${target.label.replace(/\d+/g, "#")}`;
}

export interface AuthResult {
  storage: SessionStorage;
  /** Where the app sent the user after logging in — the natural start of the authenticated crawl. */
  landedOn: string;
}

export interface AuthOutcome {
  result?: AuthResult;
  /** Why each attempt failed (empty on a first-try success). */
  failures: string[];
}

/** Longest chain of navigation clicks from an entry point. */
const MAX_STEPS = 3;

const PERSISTENT_REGION_ROLES = new Set(["navigation", "banner"]);
const NAVIGATION_ROLES = new Set(["tab", "menuitem"]);

/** Never clicked while exploring, whatever region they sit in. */
const UNSAFE_LABEL = /delete|remove|clear|reset|discard|archive|deactivate/i;

interface NavigationControl {
  target: ElementTarget;
  /** Sits in a navigation or banner landmark, so it is the same control on every screen. */
  persistent: boolean;
}

/**
 * Controls treated as navigation: buttons in navigation and banner
 * landmarks, and tabs and menu items anywhere. Buttons inside forms are
 * submissions, not navigation. Everything else stays for Semantic Contract
 * Discovery to classify.
 */
function navigationControls(
  graph: UISemanticGraph,
  exclude: RegExp,
): NavigationControl[] {
  const controls: NavigationControl[] = [];
  walk(graph.root, (node, ancestors) => {
    const label = node.label?.trim();
    if (
      !label ||
      node.state.disabled ||
      ancestors.some((a) => a.type === "form")
    )
      return;
    const persistent = ancestors.some((a) =>
      PERSISTENT_REGION_ROLES.has(a.role),
    );
    if (
      !(node.type === "button" && persistent) &&
      !NAVIGATION_ROLES.has(node.role)
    )
      return;
    if (exclude.test(label) || UNSAFE_LABEL.test(label)) return;
    controls.push({
      target: { role: node.role, label, anyNumbers: /\d/.test(label) },
      persistent,
    });
  });
  return controls;
}

/**
 * Explore — stage A. Builds a state-flow graph instead of following links
 * only. Each node is a UI state identified by its abstract key (stateKey);
 * each edge is either a same-origin link or a click on a navigation control.
 *
 * - A state with its own URL is reached by opening it; states that share a
 *   route pattern are explored once (/tasks/12 stands for /tasks/:id).
 * - A state without one is reached by replaying its clicks from the entry
 *   point, so apps that switch screens with buttons on one URL are covered.
 * - A click that sends a request that writes data is not navigation: the
 *   state behind it is not explored, and the reason is reported.
 * - For every click-reached state, one reload tells whether the app can
 *   restore it. Those it can't are returned as in-memory states, so State
 *   Consistency does not compare them against a reload.
 */
export async function exploreStates(
  driver: Driver,
  config: ScanConfig,
  session: SessionKind,
  storage?: SessionStorage,
  entries: string[] = [config.startPath ?? "/"],
): Promise<ExploreResult> {
  const s = await driver.newSession(storage);
  const origin = new URL(config.baseUrl).origin;
  const exclude = config.excludeLinkPattern ?? DEFAULT_EXCLUDE_LINK_PATTERN;
  const maxStates = config.maxPagesPerSession ?? 12;

  const frontier: StatePath[] = [...new Set(entries)].map((entry) => ({
    entry,
    steps: [],
  }));
  const queuedEntries = new Set(entries);
  const visitedPatterns = new Set<string>();
  const seenKeys = new Set<string>();
  const triedControls = new Set<string>();
  const result: ExploreResult = {
    states: [],
    failures: [],
    inMemoryStates: new Set(),
    navigation: new Set(),
  };

  try {
    while (frontier.length > 0 && result.states.length < maxStates) {
      let path = frontier.shift()!;
      const byClick = path.steps.length > 0;
      let graph: UISemanticGraph;

      try {
        if (byClick) {
          await s.restore({
            entry: path.entry,
            steps: path.steps.slice(0, -1),
          });
          await s.settle();
          const recorder = s.recordRequests();
          recorder.start();
          await s.click(path.steps[path.steps.length - 1]);
          await s.settle();
          const writes = recorder
            .stop()
            .filter((r) => r.method !== "GET" && r.method !== "HEAD");
          s.takeDialogs();
          if (writes.length) {
            result.failures.push({
              location: locationOf(path),
              session,
              error: `not explored: clicking it sent ${describeRequests(writes).join(", ")}, so it changes data rather than navigating`,
            });
            continue;
          }
          result.navigation.add(
            navigationId(path.steps[path.steps.length - 1]),
          );
        } else {
          await s.open(path.entry);
          await s.settle();
        }
        graph = await s.observe();
      } catch (err) {
        result.failures.push({
          location: locationOf(path),
          session,
          error: errorText(err),
        });
        continue;
      }

      // A click that changed the URL led to an addressable state, like a link would have.
      if (!byClick || graph.route !== path.entry) {
        const pattern = routePattern(graph.route);
        if (visitedPatterns.has(pattern)) continue;
        visitedPatterns.add(pattern);
        path = { entry: graph.route, steps: [] };
      }

      const key = stateKey(signatureFromGraph(graph));
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      result.states.push({ graph, session, path, key });

      if (path.steps.length > 0) {
        await s.reload();
        await s.settle();
        if (stateKey(signatureFromGraph(await s.observe())) !== key)
          result.inMemoryStates.add(key);
      }

      walk(graph.root, (node) => {
        const href = node.domExtra?.href;
        if (node.type !== "link" || !href) return;
        let url: URL;
        try {
          url = new URL(href);
        } catch {
          return;
        }
        if (url.origin !== origin) return;
        if (exclude.test(url.pathname) || exclude.test(node.label ?? ""))
          return;
        if (
          queuedEntries.has(url.pathname) ||
          visitedPatterns.has(routePattern(url.pathname))
        )
          return;
        queuedEntries.add(url.pathname);
        frontier.push({ entry: url.pathname, steps: [] });
      });

      if (path.steps.length >= MAX_STEPS) continue;
      for (const control of navigationControls(graph, exclude)) {
        const { role, label } = control.target;
        // A persistent control leads to the same place from every screen, so it is tried once.
        const id = control.persistent
          ? `persistent::${navigationId(control.target)}`
          : `${key}::${role}::${label}`;
        if (triedControls.has(id)) continue;
        triedControls.add(id);
        frontier.push({
          entry: path.entry,
          steps: [...path.steps, control.target],
        });
      }
    }
  } finally {
    await s.close();
  }

  return result;
}

/**
 * Logs in with the configured test account through whatever credential
 * form exploration found, and returns the saved session so the
 * authenticated exploration and candidates start already logged in.
 *
 * Success is judged generically: the route changed away from the form's
 * page after submitting. Every failed attempt comes back with its reason.
 */
export async function authenticate(
  driver: Driver,
  config: ScanConfig,
  anonymousStates: DiscoveredState[],
): Promise<AuthOutcome> {
  if (!config.credentials)
    return { failures: ["no test credentials configured"] };

  const failures: string[] = [];

  for (const state of anonymousStates) {
    const { candidates } = detectCandidates(
      state.graph,
      "anonymous",
      state.path,
    );
    const login = candidates.find(
      (c) => c.isCredentialForm && c.strategy === "validSubmit",
    );
    if (!login) continue;

    const s = await driver.newSession();
    try {
      await s.restore(login.path);
      await s.settle();
      await fillForm(s, login, config);
      await submitCandidate(s, login);
      await s.settle();

      const landedOn = s.location();
      if (routePattern(landedOn) !== routePattern(login.route)) {
        return {
          result: { storage: await s.saveStorage(), landedOn },
          failures,
        };
      }
      failures.push(
        `${login.route}: still on ${landedOn} after submitting — credentials rejected?`,
      );
    } catch (err) {
      failures.push(`${login.route}: ${errorText(err)}`);
    } finally {
      await s.close();
    }
  }

  if (failures.length === 0)
    failures.push(
      "no credential form (one password field plus one other text field) was found",
    );
  return { failures };
}
