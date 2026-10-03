import { ScanConfig } from "../config/scanConfig";
import { LEVEL_LABELS } from "../findings/evidenceLadder";
import { createLlmClient } from "../llm/createLlmClient";
import { runScan } from "../scan/runScan";

/**
 * Full pipeline through Phase 5. Expected on TaskFlow (see its README):
 * B1–B4 as bugs; I1 (image-alt), I2 (color-contrast), I3 (list scaling), I4
 * as improvements; nothing for T1–T5.
 *
 * Run from apps/backend: pnpm exec tsx src/scripts/testPhase5.ts
 * Needs: pnpm add @axe-core/playwright
 */
const config: ScanConfig = {
  baseUrl: process.env.BASE_URL ?? "http://localhost:5173",
  startPath: process.env.START_PATH ?? "/",
  credentials: {
    username: process.env.TEST_USERNAME ?? "demo@taskflow.test",
    password: process.env.TEST_PASSWORD ?? "password123",
  },
  maxPagesPerSession: 12,
};

async function main() {
  const report = await runScan(config, createLlmClient(), {
    onProgress: (m) => console.log(`… ${m}`),
  });

  console.log(`\nScanned ${report.baseUrl} with LLM ${report.llm}`);
  console.log(`Pages: ${report.stats.pages.join(", ")}\n`);

  report.findings.forEach((f, i) => {
    const basis = f.contracts.length
      ? f.contracts.join(" + ")
      : `heuristic ${f.heuristic}`;
    console.log(`${i + 1}. [${LEVEL_LABELS[f.level]}] ${f.title}`);
    console.log(
      `   ${f.kind} · ${basis} · ${f.source}${f.aiConfidence !== undefined ? ` · AI confidence ${f.aiConfidence.toFixed(2)}` : ""}`,
    );
    console.log(`   why this level: ${f.levelReason}`);
    if (f.standard) console.log(`   standard: ${f.standard}`);
    for (const line of f.evidence) console.log(`     - ${line}`);
    console.log();
  });

  if (report.discarded.length) {
    console.log("Discarded (did not hold up on a second check):");
    for (const f of report.discarded)
      console.log(`   ${f.title} — ${f.levelReason}`);
    console.log();
  }
  if (report.notChecked.length) {
    console.log("Not checked:");
    for (const n of report.notChecked)
      console.log(`   ${n.subject} — ${n.reason}`);
    console.log();
  }
  for (const c of report.cleanup)
    console.log(
      `Cleanup: ${c.removed ? "removed" : "kept"} ${c.instance.path} — ${c.note}`,
    );

  const s = report.stats;
  const bugs = report.findings.filter((f) => f.kind === "bug");
  const improvements = report.findings.filter((f) => f.kind === "improvement");
  console.log("\n=== Summary ===");
  console.log(
    `Bugs: ${bugs.length} (confirmed ${bugs.filter((f) => f.level >= 3).length}, potential ${bugs.filter((f) => f.level === 2).length})   ` +
      `Improvements: ${improvements.length}   Discarded: ${report.discarded.length}`,
  );
  console.log(
    `Scan time: ${(s.durationMs / 1000).toFixed(1)}s (network wait ${(s.networkWaitMs / 1000).toFixed(1)}s)   ` +
      `Form interactions: ${s.formCandidates}   Actions: ${s.actions}   Reruns: ${s.reruns}   ` +
      `LLM calls: ${s.llmCalls} (cache: ${s.llmCacheHits})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
