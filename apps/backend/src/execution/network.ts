import { Page, Request } from "playwright";

/**
 * Only requests that can change what the page means are waited for: the
 * document itself, scripts (lazy-loaded code), and fetch/XHR (data).
 * Images, fonts, stylesheets, media and analytics beacons never change
 * the UI Semantic Graph, and one slow image or a never-ending tracking
 * request would otherwise make every single capture wait for the full
 * timeout.
 */
const TRACKED_RESOURCE_TYPES = new Set(["document", "script", "fetch", "xhr"]);

/**
 * Upper bound for one wait. It only costs time when the app really is
 * slow: a settle returns as soon as the network has been quiet for
 * `quietMs`. It has to be generous, because capturing a page while its
 * data is still loading is worse than waiting — the page looks empty, the
 * crawl misses its links, and checks run against a half-loaded state. A
 * user waits for a slow page too; the slowness itself is reported
 * separately (request durations), not hidden by giving up early.
 */
const SETTLE_TIMEOUT_MS = 15000;

/** Set AI_TESTER_DEBUG=1 to log every settle that hits its timeout, with the requests that caused it. */
const DEBUG = process.env.AI_TESTER_DEBUG === "1";

export interface NetworkTracker {
  /**
   * Resolves once the page has had no in-flight requests for `quietMs`, or
   * after `timeoutMs` at the latest (long-polling or streaming requests
   * would otherwise keep it waiting forever).
   */
  settle(options?: { quietMs?: number; timeoutMs?: number }): Promise<void>;
}

/** Process-wide totals across every tracker, so a scan can report where its time went. */
export const settleStats = {
  settles: 0,
  timeouts: 0,
  totalWaitMs: 0,
};

/**
 * Why not page.waitForLoadState("networkidle"): that state is reached once
 * per page load, and every later call resolves immediately. After a click
 * in a single-page app there is no new page load, so it would not wait for
 * the fetch the click triggered. This tracker follows requests itself, so
 * it waits correctly after any interaction.
 *
 * In-flight requests are kept as a set of the actual request objects, not
 * a counter: a counter that misses one "finished" event (a redirect, a
 * request cancelled by navigation) stays off by one forever and turns
 * every later settle into a full timeout. A set can also say exactly which
 * requests are still pending.
 *
 * Attach it right after creating the page, before the first navigation.
 */
export function trackNetwork(page: Page): NetworkTracker {
  const inflight = new Set<Request>();
  let lastActivity = Date.now();

  page.on("request", (request) => {
    if (!TRACKED_RESOURCE_TYPES.has(request.resourceType())) return;
    inflight.add(request);
    lastActivity = Date.now();
  });
  const onEnd = (request: Request) => {
    if (!inflight.delete(request)) return;
    lastActivity = Date.now();
  };
  page.on("requestfinished", onEnd);
  page.on("requestfailed", onEnd);
  // A new document makes every request of the previous one irrelevant,
  // whether or not the browser reported them as finished.
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    for (const request of inflight) {
      if (request.resourceType() !== "document") inflight.delete(request);
    }
  });

  return {
    async settle({ quietMs = 500, timeoutMs = SETTLE_TIMEOUT_MS } = {}) {
      const start = Date.now();
      settleStats.settles++;
      // Short grace period so requests triggered by the last action have
      // time to start before "nothing in flight" is taken as "done".
      await page.waitForTimeout(100);
      while (Date.now() - start < timeoutMs) {
        if (inflight.size === 0 && Date.now() - lastActivity >= quietMs) {
          settleStats.totalWaitMs += Date.now() - start;
          return;
        }
        await page.waitForTimeout(50);
      }

      settleStats.timeouts++;
      settleStats.totalWaitMs += Date.now() - start;
      if (DEBUG) {
        const pending = [...inflight].map(
          (r) => `${r.method()} ${shorten(r.url())} (${r.resourceType()})`,
        );
        const reason = pending.length
          ? `still in flight: ${pending.slice(0, 5).join(", ")}${pending.length > 5 ? ` (+${pending.length - 5} more)` : ""}`
          : `nothing in flight, but requests kept arriving less than ${quietMs} ms apart`;
        console.warn(
          `[settle] timed out after ${timeoutMs} ms on ${shorten(page.url())}; ${reason}`,
        );
      }
    },
  };
}

function shorten(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}
