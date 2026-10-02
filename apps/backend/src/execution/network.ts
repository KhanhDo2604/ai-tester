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

export interface NetworkTracker {
  /**
   * Resolves once the page has had no in-flight requests for `quietMs`, or
   * after `timeoutMs` at the latest (long-polling or streaming requests
   * would otherwise keep it waiting forever).
   */
  settle(options?: { quietMs?: number; timeoutMs?: number }): Promise<void>;
}

/**
 * Why not page.waitForLoadState("networkidle"): that state is reached once
 * per page load, and every later call resolves immediately. After a click
 * in a single-page app there is no new page load, so it would not wait for
 * the fetch the click triggered. This tracker counts requests itself, so
 * it waits correctly after any interaction.
 *
 * Attach it right after creating the page, before the first navigation.
 */
export function trackNetwork(page: Page): NetworkTracker {
  let inflight = 0;
  let lastActivity = Date.now();

  const onStart = (request: Request) => {
    if (!TRACKED_RESOURCE_TYPES.has(request.resourceType())) return;
    inflight++;
    lastActivity = Date.now();
  };
  const onEnd = (request: Request) => {
    if (!TRACKED_RESOURCE_TYPES.has(request.resourceType())) return;
    inflight = Math.max(0, inflight - 1);
    lastActivity = Date.now();
  };

  page.on("request", onStart);
  page.on("requestfinished", onEnd);
  page.on("requestfailed", onEnd);

  return {
    async settle({ quietMs = 500, timeoutMs = 5000 } = {}) {
      const start = Date.now();
      // Short grace period so requests triggered by the last action have
      // time to start before "nothing in flight" is taken as "done".
      await page.waitForTimeout(100);
      while (Date.now() - start < timeoutMs) {
        if (inflight === 0 && Date.now() - lastActivity >= quietMs) return;
        await page.waitForTimeout(50);
      }
    },
  };
}
