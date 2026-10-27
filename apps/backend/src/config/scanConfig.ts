import { Platform } from "../driver/types";

/**
 * Everything the engine needs to know about a target app. Nothing in the
 * engine is specific to one app — any app-specific knowledge (where it
 * lives, a test account) enters only through this object.
 */
export interface ScanConfig {
  /** Which driver runs the scan. Defaults to "web". */
  platform?: Platform;

  /** Origin of the app under test, e.g. "http://localhost:5173". */
  baseUrl: string;

  /** Path the crawl starts from. Defaults to "/". */
  startPath?: string;

  /**
   * Optional test account. When present, the engine uses it on any form it
   * recognizes as a credential form (one password field plus one other
   * text field) and then scans the authenticated part of the app too.
   */
  credentials?: {
    username: string;
    password: string;
  };

  /** Upper bound on distinct UI states explored per session (anonymous / authenticated). Defaults to 12. */
  maxPagesPerSession?: number;

  /**
   * Links and navigation controls whose path or label matches this are
   * never followed while exploring, so exploration can't end its own session. Defaults to log-out /
   * sign-out style links.
   */
  excludeLinkPattern?: RegExp;
}

export const DEFAULT_EXCLUDE_LINK_PATTERN = /log\s?-?out|sign\s?-?out/i;
