import { RequestRecord } from "../execution/executeCandidate";
import { ContractCheck } from "./types";

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
export const checkNoServerError: ContractCheck = (obs) => {
  const serverErrors = obs.requests.filter(
    (r) => (r.status !== undefined && r.status >= 500) || r.failure,
  );
  const clientErrors = obs.requests.filter(
    (r) => r.status !== undefined && r.status >= 400 && r.status < 500,
  );

  if (serverErrors.length) {
    return {
      verdict: "VIOLATION",
      evidence: [
        ...serverErrors.map((r) => `server failed: ${describe(r)}`),
        ...clientErrors.map((r) => `also (not counted): ${describe(r)}`),
      ],
    };
  }

  if (obs.error && obs.requests.length === 0) {
    return {
      verdict: "NOT_APPLICABLE",
      evidence: [`interaction could not be completed: ${obs.error}`],
    };
  }

  const evidence =
    obs.requests.length === 0
      ? ["the action sent no data requests"]
      : [`${obs.requests.length} data request(s), none failed on the server`];
  for (const r of clientErrors)
    evidence.push(`client error, handled as normal behaviour: ${describe(r)}`);

  return { verdict: "SATISFIED", evidence };
};

function describe(r: RequestRecord): string {
  return `${r.method} ${r.url} → ${r.failure ?? r.status}`;
}
