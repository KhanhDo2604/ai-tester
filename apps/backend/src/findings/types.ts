import { Candidate, ContractName } from "../candidates/types";
import { ContractResult } from "../contracts/types";
import { ClassifiedAction } from "../discovery/types";

export type Subject =
  | { kind: "form"; candidate: Candidate }
  | { kind: "action"; action: ClassifiedAction };

export interface Judgment {
  violated: boolean;
  confidence: number;
  reason: string;
}

export interface CheckedResult {
  result: ContractResult;
  subject: Subject;
  judgment?: Judgment;
}

/** README §9: 0 discard, 1 potential improvement, 2 potential issue, 3 confirmed bug, 4 confirmed + named standard. */
export type EvidenceLevel = 0 | 1 | 2 | 3 | 4;

export interface Finding {
  key: string;
  title: string;
  kind: "bug" | "improvement";
  level: EvidenceLevel;
  levelReason: string;
  route: string;
  contracts: ContractName[];
  source: "predefined" | "discovered" | "judged";
  evidence: string[];
  results: CheckedResult[];
  reproduced?: boolean;
  aiConfidence?: number;
  standard?: string;
}

export function toPattern(path: string): string {
  return path
    .split("/")
    .map((s) =>
      /^\d+$/.test(s) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) ||
      /^[0-9a-f]{24}$/i.test(s)
        ? ":id"
        : s,
    )
    .join("/");
}

export function subjectName(s: Subject): string {
  return s.kind === "form" ? s.candidate.formName : s.action.control.label;
}

export function subjectRoute(s: Subject): string {
  return s.kind === "form"
    ? toPattern(s.candidate.route)
    : s.action.routePattern;
}

export function subjectId(s: Subject): string {
  return s.kind === "form"
    ? s.candidate.id
    : `${s.action.routePattern} :: ${s.action.control.label}`;
}
