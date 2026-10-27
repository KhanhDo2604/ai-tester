import { createDriver } from "../driver/createDriver";
import { walk } from "../graph/walk";

// Opens one page through the driver and prints what it sees. Run from apps/backend: pnpm exec tsx src/scripts/smokeDriver.ts [url] [path]
async function main() {
  const [baseUrl = "http://localhost:5173", path = "/"] = process.argv.slice(2);
  const driver = await createDriver({ baseUrl });
  try {
    const session = await driver.newSession();
    await session.open(path);
    await session.settle();
    const graph = await session.observe();
    const counts = new Map<string, number>();
    walk(graph.root, (node) =>
      counts.set(node.type, (counts.get(node.type) ?? 0) + 1),
    );
    console.log(`route ${session.location()}`, Object.fromEntries(counts));
    await session.close();
  } finally {
    await driver.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
