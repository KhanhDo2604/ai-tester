import { writeFileSync } from "fs";
import { createLlmClient } from "../llm/createLlmClient";
import { runScan } from "../scan/runScan";
import { buildReport } from "../report/buildReport";

// Regression summary of one scan.
async function main() {
  const [baseUrl, out] = process.argv.slice(2);
  const scan = await runScan(
    { baseUrl, startPath: "/", maxPagesPerSession: 12 },
    createLlmClient(),
    {
      onProgress: (m) => console.log("…", m),
    },
  );
  const r = buildReport("regress", scan);
  const summary = {
    pages: r.coverage.pages,
    items: [...r.bugs, ...r.improvements]
      .map((i) => `[${i.level}] ${i.title} (${i.route})`)
      .sort(),
    notChecked: r.notChecked
      .map((n: any) => `${n.subject}: ${n.reason}`)
      .sort(),
    cleanup: r.cleanup
      .map(
        (c: any) =>
          `${c.removed ? "removed" : "kept"} ${c.path ?? c.instance?.path}`,
      )
      .sort(),
    stats: scan.stats,
  };
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify(
      { ...summary, notChecked: summary.notChecked.length },
      null,
      2,
    ),
  );
}
main();
