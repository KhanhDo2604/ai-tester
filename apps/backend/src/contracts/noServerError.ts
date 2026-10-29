import { RequestRecord } from "../driver/types";
import { ContractCheck, ContractResult } from "./types";

/**
 * No Server Error — a user action must not make the server fail.
 *
 * Only two outcomes count as failure:
 * - a 5xx response: the server itself broke while handling the request;
 * - no response at all (connection refused, reset): the request never
 *   completed.
 *
 * 4xx responses are deliberately NOT violations. A 404 for a resource
 * that doesn't exist, a 401 for wrong credentials or a 400 for invalid
 * input is the server working correctly and telling the client so. An
 * "error" status code on one request is not the same thing as the system
 * malfunctioning. They are listed in the evidence for context only.
 *
 * Whether the UI also showed an error message doesn't change the verdict:
 * a friendly "Something went wrong" over a 500 is good error handling on
 * top of a real server bug, not a fix for it.
 */
export function serverErrorResult(
  requests: RequestRecord[],
  error?: string,
): Pick<ContractResult, "verdict" | "evidence"> {
  const serverErrors = requests.filter(
    (r) => (r.status !== undefined && r.status >= 500) || r.failure,
  );
  const clientErrors = requests.filter(
    (r) => r.status !== undefined && r.status >= 400 && r.status < 500,
  );

  if (serverErrors.length) {
    return {
      verdict: "VIOLATION",
      evidence: [
        ...describeRequests(serverErrors).map(
          (line) => `server failed: ${line}`,
        ),
        ...describeRequests(clientErrors).map(
          (line) => `also (not counted): ${line}`,
        ),
      ],
    };
  }

  if (error && requests.length === 0) {
    return {
      verdict: "NOT_APPLICABLE",
      evidence: [`interaction could not be completed: ${error}`],
    };
  }

  const evidence =
    requests.length === 0
      ? ["the action sent no data requests"]
      : [`${requests.length} data request(s), none failed on the server`];
  for (const line of describeRequests(clientErrors))
    evidence.push(`client error, handled as normal behaviour: ${line}`);
  const slow = requests.filter(
    (r) => (r.durationMs ?? 0) >= SLOW_RESPONSE_MS && !clientErrors.includes(r),
  );
  for (const line of describeRequests(slow))
    evidence.push(`slow response (noted for the performance check): ${line}`);

  return { verdict: "SATISFIED", evidence };
}

export const checkNoServerError: ContractCheck = (obs) =>
  serverErrorResult(obs.requests, obs.error);

/** Responses slower than this get their duration shown in the evidence. */
const SLOW_RESPONSE_MS = 1000;

export function describeRequest(r: RequestRecord): string {
  const slow =
    r.durationMs !== undefined && r.durationMs >= SLOW_RESPONSE_MS
      ? ` (took ${(r.durationMs / 1000).toFixed(1)} s)`
      : "";
  return `${r.method} ${r.url} → ${r.failure ?? r.status}${slow}`;
}

/**
 * Collapses identical request lines (same method, URL and outcome) into
 * one line with a count. Apps in development mode often fire the same
 * request twice (React StrictMode runs effects twice), which otherwise
 * doubles every line of evidence without adding information.
 */
export function describeRequests(requests: RequestRecord[]): string[] {
  const groups = new Map<string, { line: string; count: number }>();
  for (const r of requests) {
    const key = `${r.method} ${r.url} ${r.failure ?? r.status}`;
    const existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, { line: describeRequest(r), count: 1 });
  }
  return [...groups.values()].map((g) =>
    g.count > 1 ? `${g.line} ×${g.count}` : g.line,
  );
}
