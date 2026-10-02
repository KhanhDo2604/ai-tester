import { Browser } from "playwright";
import { detectCandidates } from "../candidates/detectCandidates";
import { SessionKind } from "../candidates/types";
import { DEFAULT_EXCLUDE_LINK_PATTERN, ScanConfig } from "../config/scanConfig";
import { buildUISemanticGraph } from "../graph/buildGraph";
import { UISemanticGraph } from "../graph/types";
import { walk } from "../graph/walk";
import {
  fillForm,
  navigate,
  openPage,
  StorageState,
  submitCandidate,
} from "../execution/executeCandidate";

export interface DiscoveredPage {
  graph: UISemanticGraph;
  session: SessionKind;
}

/** A page the crawl tried to open but couldn't — reported, never silently dropped. */
export interface CrawlFailure {
  path: string;
  session: SessionKind;
  error: string;
}

export interface CrawlResult {
  pages: DiscoveredPage[];
  failures: CrawlFailure[];
}

export interface AuthResult {
  storageState: StorageState;
  /** Where the app sent the user after logging in — the natural start of the authenticated crawl. */
  landedOn: string;
}

export interface AuthOutcome {
  /** Present when login succeeded. */
  result?: AuthResult;
  /** Why each attempt failed (empty on a first-try success). */
  failures: string[];
}

/**
 * Collapses ids in a path so /tasks/12 and /tasks/57 count as one page
 * shape (/tasks/:id). Without this, a list with many items would use up
 * the whole page budget on copies of the same page.
 */
export function routePattern(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) =>
      /^\d+$/.test(segment) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment) ||
      /^[0-9a-f]{24}$/i.test(segment)
        ? ":id"
        : segment,
    )
    .join("/");
}

/**
 * Breadth-first crawl over same-origin links found in the UI Semantic
 * Graph. Pages are deduplicated by their final route pattern, so a link
 * that redirects (e.g. /login when already logged in) doesn't produce a
 * duplicate page.
 */
export async function discoverPages(
  browser: Browser,
  config: ScanConfig,
  session: SessionKind,
  storageState?: StorageState,
  startPaths: string[] = [config.startPath ?? "/"],
): Promise<CrawlResult> {
  const { context, page, network } = await openPage(
    browser,
    config,
    storageState,
  );

  const origin = new URL(config.baseUrl).origin;
  const exclude = config.excludeLinkPattern ?? DEFAULT_EXCLUDE_LINK_PATTERN;
  const maxPages = config.maxPagesPerSession ?? 12;

  const queue: string[] = [...new Set(startPaths)];
  const queued = new Set(queue);
  const visitedPatterns = new Set<string>();
  const pages: DiscoveredPage[] = [];
  const failures: CrawlFailure[] = [];

  try {
    while (queue.length > 0 && pages.length < maxPages) {
      const path = queue.shift()!;
      try {
        await navigate(page, path);
      } catch (err) {
        failures.push({
          path,
          session,
          error:
            err instanceof Error ? err.message.split("\n")[0] : String(err),
        });
        continue;
      }
      await network.settle();

      const graph = await buildUISemanticGraph(page);
      const pattern = routePattern(graph.route);
      if (visitedPatterns.has(pattern)) continue;
      visitedPatterns.add(pattern);
      pages.push({ graph, session });

      walk(graph.root, (node) => {
        const href = node.domExtra?.href;
        if (node.type !== "link" || !href) return;
        let url: URL;
        try {
          url = new URL(href, page.url());
        } catch {
          return;
        }
        if (url.origin !== origin) return;
        if (exclude.test(url.pathname) || exclude.test(node.label ?? ""))
          return;
        if (
          queued.has(url.pathname) ||
          visitedPatterns.has(routePattern(url.pathname))
        )
          return;
        queued.add(url.pathname);
        queue.push(url.pathname);
      });
    }
  } finally {
    await context.close();
  }

  return { pages, failures };
}

/**
 * Logs in with the configured test account through whatever credential
 * form the anonymous crawl found, and returns the resulting browser
 * storage (cookies + localStorage) so the authenticated crawl and
 * authenticated candidates can start already logged in.
 *
 * Success is judged generically: the route changed away from the form's
 * page after submitting.
 *
 * Every failed attempt is returned with its reason, so "login failed" is
 * never a mystery: wrong credentials, no credential form found, and a
 * server that didn't respond look very different in a report.
 */
export async function authenticate(
  browser: Browser,
  config: ScanConfig,
  anonymousPages: DiscoveredPage[],
): Promise<AuthOutcome> {
  if (!config.credentials)
    return { failures: ["no test credentials configured"] };

  const failures: string[] = [];

  for (const discovered of anonymousPages) {
    const { candidates } = detectCandidates(discovered.graph, "anonymous");
    const login = candidates.find(
      (c) => c.isCredentialForm && c.strategy === "validSubmit",
    );
    if (!login) continue;

    const { context, page, network } = await openPage(browser, config);

    try {
      await navigate(page, login.route);
      await network.settle();
      await fillForm(page, login, config);
      await submitCandidate(page, login);
      await network.settle();

      const landedOn = new URL(page.url()).pathname;
      if (routePattern(landedOn) !== routePattern(login.route)) {
        return {
          result: { storageState: await context.storageState(), landedOn },
          failures,
        };
      }
      failures.push(
        `${login.route}: still on ${landedOn} after submitting — credentials rejected?`,
      );
    } catch (err) {
      failures.push(
        `${login.route}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
    } finally {
      await context.close();
    }
  }

  if (failures.length === 0)
    failures.push(
      "no credential form (one password field plus one other text field) was found",
    );
  return { failures };
}
