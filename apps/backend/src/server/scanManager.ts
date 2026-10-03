import { randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { ScanConfig } from "../config/scanConfig";
import { LlmClient } from "../llm/types";
import { applySuppressions, buildReport } from "../report/buildReport";
import { Report } from "../report/types";
import { runScan } from "../scan/runScan";

export interface ScanRequest {
  baseUrl: string;
  startPath?: string;
  username?: string;
  password?: string;
}

export type ScanEvent =
  | { type: "progress"; at: string; message: string }
  | { type: "done"; at: string; reportId: string }
  | { type: "failed"; at: string; error: string };

interface ScanState {
  id: string;
  target: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  events: ScanEvent[];
  listeners: Set<(e: ScanEvent) => void>;
}

const REPORTS_DIR = join(process.cwd(), ".ai-tester-data", "reports");

export class ScanManager {
  private scans = new Map<string, ScanState>();

  constructor(private readonly llm: LlmClient | undefined) {}

  /** One scan at a time: each runs a browser and acts on the target app. */
  isBusy(): boolean {
    return [...this.scans.values()].some((s) => s.status === "running");
  }

  start(request: ScanRequest): string {
    const id = randomUUID();
    const state: ScanState = {
      id,
      target: request.baseUrl,
      status: "running",
      startedAt: new Date().toISOString(),
      events: [],
      listeners: new Set(),
    };
    this.scans.set(id, state);

    const config: ScanConfig = {
      baseUrl: request.baseUrl,
      startPath: request.startPath || "/",
      credentials:
        request.username && request.password
          ? { username: request.username, password: request.password }
          : undefined,
      maxPagesPerSession: 12,
    };

    const emit = (event: ScanEvent) => {
      state.events.push(event);
      state.listeners.forEach((l) => l(event));
    };

    runScan(config, this.llm, {
      onProgress: (message) =>
        emit({ type: "progress", at: new Date().toISOString(), message }),
    })
      .then((scan) => {
        const report = buildReport(id, scan);
        mkdirSync(REPORTS_DIR, { recursive: true });
        writeFileSync(
          join(REPORTS_DIR, `${id}.json`),
          JSON.stringify(report, null, 2),
        );
        state.status = "done";
        emit({ type: "done", at: new Date().toISOString(), reportId: id });
      })
      .catch((err) => {
        state.status = "failed";
        emit({
          type: "failed",
          at: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return id;
  }

  status(id: string) {
    const state = this.scans.get(id);
    if (state) {
      return {
        id,
        target: state.target,
        status: state.status,
        startedAt: state.startedAt,
        events: state.events,
        report: this.report(id),
      };
    }
    const report = this.report(id);
    return report
      ? {
          id,
          target: report.target,
          status: "done" as const,
          events: [],
          report,
        }
      : undefined;
  }

  /** Replays past events, then streams new ones. Returns an unsubscribe function. */
  subscribe(
    id: string,
    listener: (e: ScanEvent) => void,
  ): (() => void) | undefined {
    const state = this.scans.get(id);
    if (!state) return undefined;
    state.events.forEach(listener);
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  report(id: string): Report | undefined {
    const file = join(REPORTS_DIR, `${id}.json`);
    if (!/^[0-9a-f-]{36}$/.test(id) || !existsSync(file)) return undefined;
    return applySuppressions(JSON.parse(readFileSync(file, "utf8")));
  }

  history(): {
    id: string;
    target: string;
    finishedAt: string;
    summary: Report["summary"];
  }[] {
    if (!existsSync(REPORTS_DIR)) return [];
    return readdirSync(REPORTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.report(f.replace(/\.json$/, "")))
      .filter((r): r is Report => Boolean(r))
      .map((r) => ({
        id: r.id,
        target: r.target,
        finishedAt: r.finishedAt,
        summary: r.summary,
      }))
      .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  }
}
