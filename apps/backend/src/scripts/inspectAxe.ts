import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { ScanConfig } from "../config/scanConfig";
import { authenticate, discoverPages } from "../crawl/discoverPages";
import { navigate, openPage } from "../execution/executeCandidate";

/**
 * Diagnostic: every axe result for one page, including "incomplete"
 * (axe could not decide) and contrast rules, so a missed finding can be traced.
 *
 * Run from apps/backend: pnpm exec tsx src/scripts/inspectAxe.ts
 * Env: AXE_ROUTE (default /profile), plus BASE_URL, TEST_USERNAME, TEST_PASSWORD.
 */
const config: ScanConfig = {
  baseUrl: process.env.BASE_URL ?? "http://localhost:5173",
  startPath: "/login",
  credentials: {
    username: process.env.TEST_USERNAME ?? "demo@taskflow.test",
    password: process.env.TEST_PASSWORD ?? "password123",
  },
  maxPagesPerSession: 2,
};
const route = process.env.AXE_ROUTE ?? "/profile";

async function main() {
  const browser = await chromium.launch();
  try {
    const anonymous = await discoverPages(browser, config, "anonymous");
    const auth = (await authenticate(browser, config, anonymous.pages)).result;
    const { context, page, network } = await openPage(
      browser,
      config,
      auth?.storageState,
    );
    await navigate(page, route);
    await network.settle();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    for (const [group, items] of [
      ["VIOLATIONS", results.violations],
      ["INCOMPLETE (needs review)", results.incomplete],
    ] as const) {
      console.log(`\n=== ${group} on ${route} ===`);
      for (const v of items) {
        console.log(`\n[${v.id}] ${v.help}`);
        for (const n of v.nodes) {
          console.log(`  ${n.target.join(" ")}`);
          console.log(`    ${n.html.slice(0, 200)}`);
          const messages = [...n.any, ...n.all, ...n.none]
            .map((c) => c.message)
            .filter(Boolean);
          for (const m of messages) console.log(`    → ${m}`);
        }
      }
    }

    // `any` because the backend tsconfig has no DOM lib; this callback runs in the browser.
    const grey: string[] = await page.evaluate(() => {
      const w = globalThis as any;
      return Array.from(w.document.querySelectorAll("body *") as ArrayLike<any>)
        .filter(
          (el) => el.children.length === 0 && (el.textContent ?? "").trim(),
        )
        .filter((el) => w.getComputedStyle(el).color === "rgb(163, 163, 168)")
        .map((el) => {
          const parents: string[] = [];
          for (
            let p = el.parentElement;
            p && p.tagName !== "BODY";
            p = p.parentElement
          )
            parents.push(p.tagName.toLowerCase());
          return `${el.outerHTML.slice(0, 200)}\n    inside: ${parents.join(" < ")}`;
        });
    });
    console.log(
      `\n=== Elements with color #a3a3a8 ===\n${grey.join("\n") || "(none)"}`,
    );
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
