import { Page } from "playwright";
import { DiscoveredPage } from "../crawl/discoverPages";
import {
  createOwnInstance,
  OwnInstance,
  rankCreators,
} from "../entity/ownInstance";
import {
  navigate,
  openPage,
  recordDataRequests,
  RequestRecorder,
} from "../execution/executeCandidate";
import { NetworkTracker } from "../execution/network";
import { buildUISemanticGraph } from "../graph/buildGraph";
import { walk } from "../graph/walk";
import { RunContext } from "../findings/reproduce";
import { Finding, toPattern } from "../findings/types";

const EXTRA_RECORDS = 3;
const LOADS_PER_MEASUREMENT = 2;
const MIN_DURATION_MS = 500;
const MIN_PER_RECORD_MS = 50;

interface Measurement {
  records: number;
  /** All observed durations per endpoint ("GET /api/tasks"), one per load. */
  durations: Map<string, number[]>;
}

export interface ScalingResult {
  findings: Finding[];
  created: { instance: OwnInstance; pattern: string }[];
  notes: string[];
}

/**
 * Metamorphic check (README §14.1) for performance: load a list page, add a
 * few own records, load it again. If a data request gets slower by a steady
 * amount per added record, the server does work once per record — the
 * symptom of an N+1 query — even though that code is invisible from here.
 */
export async function checkListScaling(
  ctx: RunContext,
  pages: DiscoveredPage[],
): Promise<ScalingResult> {
  const out: ScalingResult = { findings: [], created: [], notes: [] };

  for (const discovered of pages) {
    const route = discovered.graph.route;
    if (toPattern(route).includes(":id")) continue;
    const recordPattern = mostLinkedRecordPattern(discovered);
    if (!recordPattern) continue;

    const creators = rankCreators(
      ctx.candidates,
      recordPattern,
      discovered.session,
    );
    if (creators.length === 0) {
      out.notes.push(
        `${route}: lists ${recordPattern} records, but no form to create one was found`,
      );
      continue;
    }

    const storage =
      discovered.session === "authenticated" ? ctx.storageState : undefined;
    const { context, page, network } = await openPage(
      ctx.browser,
      ctx.config,
      storage,
    );
    const recorder = recordDataRequests(page);
    try {
      const before = await measure(
        page,
        network,
        recorder,
        route,
        recordPattern,
      );

      for (let i = 0; i < EXTRA_RECORDS; i++) {
        const result = await createOwnInstance(
          page,
          network,
          ctx.config,
          creators[0],
          recordPattern,
        );
        if ("failure" in result) break;
        out.created.push({ instance: result, pattern: recordPattern });
      }

      const after = await measure(
        page,
        network,
        recorder,
        route,
        recordPattern,
      );
      const added = after.records - before.records;
      if (added < 1) {
        out.notes.push(
          `${route}: the number of listed records did not change after creating some, so scaling could not be measured`,
        );
        continue;
      }
      out.findings.push(...compare(route, before, after, added));
    } catch (err) {
      out.notes.push(
        `${route}: scaling check failed — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
    } finally {
      await context.close();
    }
  }

  return out;
}

function mostLinkedRecordPattern(
  discovered: DiscoveredPage,
): string | undefined {
  const counts = new Map<string, number>();
  walk(discovered.graph.root, (node) => {
    if (node.type !== "link" || !node.domExtra?.href) return;
    const pattern = toPattern(new URL(node.domExtra.href, "http://x").pathname);
    if (pattern.includes(":id"))
      counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

async function measure(
  page: Page,
  network: NetworkTracker,
  recorder: RequestRecorder,
  route: string,
  recordPattern: string,
): Promise<Measurement> {
  const durations = new Map<string, number[]>();
  let records = 0;

  for (let i = 0; i < LOADS_PER_MEASUREMENT; i++) {
    recorder.start();
    await navigate(page, route);
    await network.settle();
    const requests = recorder.stop();

    const fastestPerKey = new Map<string, number>();
    for (const r of requests) {
      if (
        r.method !== "GET" ||
        r.durationMs === undefined ||
        !r.status ||
        r.status >= 400
      )
        continue;
      const key = `GET ${toPattern(r.url.split("?")[0])}`;
      fastestPerKey.set(
        key,
        Math.min(fastestPerKey.get(key) ?? Infinity, r.durationMs),
      );
    }
    for (const [key, ms] of fastestPerKey)
      durations.set(key, [...(durations.get(key) ?? []), ms]);

    records = 0;
    walk((await buildUISemanticGraph(page)).root, (node) => {
      if (
        node.type === "link" &&
        node.domExtra?.href &&
        toPattern(new URL(node.domExtra.href, page.url()).pathname) ===
          recordPattern
      ) {
        records++;
      }
    });
  }

  return { records, durations };
}

function compare(
  route: string,
  before: Measurement,
  after: Measurement,
  added: number,
): Finding[] {
  const findings: Finding[] = [];

  for (const [key, beforeMs] of before.durations) {
    const afterMs = after.durations.get(key);
    if (!afterMs) continue;
    const d0 = Math.min(...beforeMs);
    const d1 = Math.min(...afterMs);
    const perRecord = (d1 - d0) / added;
    if (d1 < MIN_DURATION_MS || perRecord < MIN_PER_RECORD_MS) continue;

    // Every load with more records was slower than every load with fewer.
    const reproduced = Math.min(...afterMs) > Math.max(...beforeMs);
    findings.push({
      key: `heuristic::list-scaling::${key}`,
      title: `${key} gets slower with every record in the list (≈${Math.round(perRecord)} ms per record)`,
      kind: "improvement",
      level: 0,
      levelReason: "",
      route: toPattern(route),
      contracts: [],
      source: "heuristic",
      heuristic: "list-scaling",
      evidence: [
        `${key} with ${before.records} records listed on ${route}: ${beforeMs.map((ms) => `${ms} ms`).join(", ")}`,
        `after adding ${added} own records (${after.records} listed): ${afterMs.map((ms) => `${ms} ms`).join(", ")}`,
        `≈${Math.round(perRecord)} ms more per record: the server does work once per record, which points to a per-record query (N+1)`,
      ],
      results: [],
      reproduced,
    });
  }

  return findings;
}
