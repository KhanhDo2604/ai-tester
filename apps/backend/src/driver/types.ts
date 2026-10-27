import type { Page } from "playwright";
import { UISemanticGraph } from "../graph/types";

/**
 * The only boundary between the engine and a platform. Everything from
 * the UI Semantic Graph onward talks to these interfaces, never to
 * Playwright (or, later, Appium) directly.
 */
export type Platform = "web" | "android" | "ios";

/** Saved login state a driver can start a new session from (cookies and storage on the web). */
export interface SessionStorage {
  platform: Platform;
  data: unknown;
}

/** An element found again by its accessible role and name. */
export interface ElementTarget {
  role: string;
  label: string;
  /** Match the label with any numbers in it ("Cart 0" also finds "Cart 3"). */
  anyNumbers?: boolean;
}

/** A field to fill. `inputType` and `tag` come from the platform and refine how it is filled. */
export interface FieldTarget extends ElementTarget {
  inputType?: string;
  tag?: string;
  disabled?: boolean;
}

/**
 * How to reach a UI state from scratch: open an entry point, then
 * activate navigation controls in order. A state with an address of its
 * own (a URL) has no steps.
 */
export interface StatePath {
  entry: string;
  steps: ElementTarget[];
}

/** One data request made while an interaction ran. */
export interface RequestRecord {
  method: string;
  /** Path and query only. */
  url: string;
  status?: number;
  /** Set instead of `status` when no response arrived. */
  failure?: string;
  durationMs?: number;
}

export interface RequestRecorder {
  start(): void;
  /** Stops recording and returns everything recorded since start(). */
  stop(): RequestRecord[];
}

/** One isolated session: a browser context on the web, a freshly cleared app on mobile. */
export interface Session {
  readonly platform: Platform;

  /** Opens an entry point (a path on the web). */
  open(entry: string): Promise<void>;
  /** Reaches a state from scratch by replaying its path. */
  restore(path: StatePath): Promise<void>;
  /** Reloads the current state the way a user would (page reload, app restart). */
  reload(): Promise<void>;
  /** Address of the current state (the pathname on the web). */
  location(): string;

  /** Waits until the app is idle after the last action. */
  settle(options?: { quietMs?: number; timeoutMs?: number }): Promise<void>;
  /** The UI Semantic Graph of the current state, without waiting. */
  observe(): Promise<UISemanticGraph>;

  click(target: ElementTarget, options?: { last?: boolean }): Promise<void>;
  /** Returns false when the field can't be edited. */
  fill(field: FieldTarget, value: string): Promise<boolean>;
  setChecked(field: FieldTarget, checked: boolean): Promise<boolean>;
  selectOption(field: FieldTarget, index: number): Promise<boolean>;
  pressEnter(field: FieldTarget): Promise<void>;
  isDisabled(target: ElementTarget): Promise<boolean>;
  /** Whether the platform's own input validation would block submitting with this control. */
  nativeValidationBlocks(target: ElementTarget): Promise<boolean>;
  /** Resolves true once the text is visible, false after the timeout. */
  waitForText(text: string, timeoutMs: number): Promise<boolean>;

  /** System dialogs (alert, confirm) shown since the last call, all accepted. */
  takeDialogs(): string[];
  recordRequests(): RequestRecorder;
  saveStorage(): Promise<SessionStorage>;
  close(): Promise<void>;

  /** Platform escape hatch for platform-specific checks only (axe-core on the web). */
  readonly web?: { page: Page };
}

export interface Driver {
  readonly platform: Platform;
  /** A fresh session that shares nothing with any other, optionally already logged in. */
  newSession(storage?: SessionStorage): Promise<Session>;
  /** Total time spent waiting for the app to become idle, across all sessions. */
  idleWaitMs(): number;
  close(): Promise<void>;
}

export function locationOf(path: StatePath): string {
  return path.steps.length
    ? [path.entry, ...path.steps.map((s) => s.label)].join(" › ")
    : path.entry;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}
