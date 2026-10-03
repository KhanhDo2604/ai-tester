import { EvidenceLevel } from "../findings/types";

export type SuppressionReason =
  "false-positive" | "intended-behaviour" | "wont-fix";

export interface Suppression {
  reason: SuppressionReason;
  note?: string;
  at: string;
}

export interface ReportItem {
  id: string;
  /** Stable across scans; used to suppress a finding. */
  key: string;
  kind: "bug" | "improvement";
  level: EvidenceLevel;
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
  /** Things that make this report incomplete, shown above everything else. */
  warnings: string[];
  notChecked: { subject: string; reason: string }[];
  cleanup: { path: string; removed: boolean; note: string }[];
}
