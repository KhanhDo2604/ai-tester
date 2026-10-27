import {
  Browser,
  BrowserContext,
  chromium,
  Locator,
  Page,
  Request,
} from "playwright";
import {
  Driver,
  ElementTarget,
  FieldTarget,
  RequestRecord,
  RequestRecorder,
  Session,
  SessionStorage,
  StatePath,
} from "../types";
import { buildUISemanticGraph } from "../../graph/buildGraph";
import {
  NetworkTracker,
  settleStats,
  trackNetwork,
} from "../../execution/network";

type AriaRole = Parameters<Page["getByRole"]>[0];
type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Element actions fail fast; a missing element shouldn't stall a scan. */
const ACTION_TIMEOUT_MS = 5000;

/** A remote app on a cold-starting host can take well over 10 seconds to answer. */
const NAVIGATION_TIMEOUT_MS = 30000;

/** Requests that carry application data, as opposed to page assets. */
const DATA_REQUEST_TYPES = new Set(["fetch", "xhr"]);

export async function createWebDriver(baseUrl: string): Promise<Driver> {
  const browser = await chromium.launch();
  const waitAtStart = settleStats.totalWaitMs;
  return {
    platform: "web",
    newSession: (storage) => WebSession.open(browser, baseUrl, storage),
    idleWaitMs: () => settleStats.totalWaitMs - waitAtStart,
    close: () => browser.close(),
  };
}

class WebSession implements Session {
  readonly platform = "web" as const;
  readonly web: { page: Page };
  private dialogs: string[] = [];

  private constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly network: NetworkTracker,
  ) {
    this.web = { page };
    page.on("dialog", async (dialog) => {
      this.dialogs.push(dialog.message());
      await dialog.accept().catch(() => {});
    });
  }

  static async open(
    browser: Browser,
    baseUrl: string,
    storage?: SessionStorage,
  ): Promise<WebSession> {
    const context = await browser.newContext({
      baseURL: baseUrl,
      storageState: storage?.data as StorageState | undefined,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    // Attached before the first navigation so no request is missed.
    const network = trackNetwork(page);
    return new WebSession(context, page, network);
  }

  // "load" waits for every image and third-party script; DOMContentLoaded plus settle() is enough.
  async open(entry: string): Promise<void> {
    await this.page.goto(entry, { waitUntil: "domcontentloaded" });
  }

  async restore(path: StatePath): Promise<void> {
    await this.open(path.entry);
    for (const step of path.steps) {
      await this.settle();
      await this.click(step);
    }
  }

  async reload(): Promise<void> {
    await this.page.reload({ waitUntil: "domcontentloaded" });
  }

  location(): string {
    return new URL(this.page.url()).pathname;
  }

  settle(options?: { quietMs?: number; timeoutMs?: number }): Promise<void> {
    return this.network.settle(options);
  }

  observe() {
    return buildUISemanticGraph(this.page);
  }

  private locate(target: ElementTarget): Locator {
    const name = target.anyNumbers
      ? numberTolerant(target.label)
      : target.label;
    return this.page.getByRole(target.role as AriaRole, { name, exact: true });
  }

  async click(
    target: ElementTarget,
    options?: { last?: boolean },
  ): Promise<void> {
    const all = this.locate(target);
    await (options?.last ? all.last() : all.first()).click();
  }

  private async editable(field: FieldTarget): Promise<Locator | undefined> {
    const locator = this.locate(field).first();
    return (await locator.isEditable().catch(() => false))
      ? locator
      : undefined;
  }

  async fill(field: FieldTarget, value: string): Promise<boolean> {
    const locator = await this.editable(field);
    if (locator) await locator.fill(value);
    return Boolean(locator);
  }

  async setChecked(field: FieldTarget, checked: boolean): Promise<boolean> {
    const locator = await this.editable(field);
    if (locator) await (checked ? locator.check() : locator.uncheck());
    return Boolean(locator);
  }

  async selectOption(field: FieldTarget, index: number): Promise<boolean> {
    const locator = await this.editable(field);
    if (locator) await locator.selectOption({ index }).catch(() => {});
    return Boolean(locator);
  }

  async pressEnter(field: FieldTarget): Promise<void> {
    await this.locate(field).first().press("Enter");
  }

  isDisabled(target: ElementTarget): Promise<boolean> {
    return this.locate(target).first().isDisabled();
  }

  nativeValidationBlocks(target: ElementTarget): Promise<boolean> {
    return this.locate(target)
      .first()
      .evaluate((el: any) => {
        const form = el.form;
        return form ? !form.noValidate && !form.checkValidity() : false;
      });
  }

  async waitForText(text: string, timeoutMs: number): Promise<boolean> {
    return this.page
      .getByText(text)
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);
  }

  takeDialogs(): string[] {
    const shown = this.dialogs;
    this.dialogs = [];
    return shown;
  }

  recordRequests(): RequestRecorder {
    return recordDataRequests(this.page);
  }

  async saveStorage(): Promise<SessionStorage> {
    return { platform: "web", data: await this.context.storageState() };
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

function numberTolerant(label: string): RegExp {
  const escaped = label
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\d+/g, "\\d+");
  return new RegExp(`^${escaped}$`);
}

/** Records fetch/XHR between start() and stop(), so each request belongs to one interaction. */
function recordDataRequests(page: Page): RequestRecorder {
  let recording = false;
  let records: RequestRecord[] = [];
  const startedAt = new Map<Request, number>();

  page.on("request", (request) => {
    if (recording && DATA_REQUEST_TYPES.has(request.resourceType()))
      startedAt.set(request, Date.now());
  });
  const elapsed = (request: Request): number | undefined => {
    const start = startedAt.get(request);
    startedAt.delete(request);
    return start === undefined ? undefined : Date.now() - start;
  };

  page.on("response", (response) => {
    const request = response.request();
    if (!recording || !DATA_REQUEST_TYPES.has(request.resourceType())) return;
    records.push({
      method: request.method(),
      url: pathOf(request.url()),
      status: response.status(),
      durationMs: elapsed(request),
    });
  });
  page.on("requestfailed", (request) => {
    if (!recording || !DATA_REQUEST_TYPES.has(request.resourceType())) return;
    const failure = request.failure()?.errorText ?? "unknown error";
    const durationMs = elapsed(request);
    // ERR_ABORTED: the browser cancelled it itself, almost always because the page navigated.
    if (failure.includes("ERR_ABORTED")) return;
    records.push({
      method: request.method(),
      url: pathOf(request.url()),
      failure,
      durationMs,
    });
  });

  return {
    start() {
      records = [];
      startedAt.clear();
      recording = true;
    },
    stop() {
      recording = false;
      return records;
    },
  };
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}
