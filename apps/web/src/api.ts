/// <reference types="vite/client" />

export const API_URL: string =
  import.meta.env.VITE_API_URL ?? "http://localhost:4100";

export type SuppressionReason =
  "false-positive" | "intended-behaviour" | "wont-fix";

export interface Suppression {
  reason: SuppressionReason;
  note?: string;
  at: string;
}

export interface ReportItem {
  id: string;
  key: string;
  kind: "bug" | "improvement";
  level: 0 | 1 | 2 | 3 | 4;
  levelLabel: string;
  title: string;
  summary: string;
  route: string;
  steps: string[];
  expected: string;
  actual: string;
  whyLevel: string;
  standard?: string;
  source: "predefined" | "discovered" | "judged" | "heuristic";
  aiConfidence?: number;
  evidence: string[];
  markdown: string;
  suppression?: Suppression;
}

export interface Report {
  id: string;
  target: string;
  llm: string;
  finishedAt: string;
  summary: {
    confirmedBugs: number;
    potentialIssues: number;
    improvements: number;
    suppressed: number;
    discarded: number;
  };
  coverage: {
    pages: string[];
    formInteractions: number;
    actions: number;
    reruns: number;
    llmCalls: number;
    llmCacheHits: number;
    durationMs: number;
    networkWaitMs: number;
  };
  bugs: ReportItem[];
  improvements: ReportItem[];
  suppressed: ReportItem[];
  discarded: ReportItem[];
  warnings?: string[];
  notChecked: { subject: string; reason: string }[];
  cleanup: { path: string; removed: boolean; note: string }[];
}

export interface ScanStatus {
  id: string;
  target: string;
  status: "running" | "done" | "failed";
  report?: Report;
}

export interface HistoryEntry {
  id: string;
  target: string;
  finishedAt: string;
  summary: Report["summary"];
}

export interface ScanInput {
  baseUrl: string;
  startPath?: string;
  username?: string;
  password?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  startScan: (input: ScanInput) =>
    request<{ id: string }>("/api/scans", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  history: () => request<HistoryEntry[]>("/api/scans"),
  scan: (id: string) => request<ScanStatus>(`/api/scans/${id}`),
  suppress: (
    target: string,
    key: string,
    reason: SuppressionReason,
    note?: string,
  ) =>
    request("/api/suppressions", {
      method: "POST",
      body: JSON.stringify({ target, key, reason, note }),
    }),
  unsuppress: (target: string, key: string) =>
    request("/api/suppressions", {
      method: "DELETE",
      body: JSON.stringify({ target, key }),
    }),
  eventsUrl: (id: string) => `${API_URL}/api/scans/${id}/events`,
};

export const REASON_LABELS: Record<SuppressionReason, string> = {
  "false-positive": "False positive",
  "intended-behaviour": "Intended behaviour",
  "wont-fix": "Won't fix",
};
