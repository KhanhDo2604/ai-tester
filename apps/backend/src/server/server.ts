import { createServer, IncomingMessage, ServerResponse } from "http";
import { createLlmClient } from "../llm/createLlmClient";
import { suppress, unsuppress } from "../report/suppressions";
import { SuppressionReason } from "../report/types";
import { ScanManager, ScanRequest } from "./scanManager";

/**
 * API for the web UI.
 *   POST   /api/scans               start a scan
 *   GET    /api/scans               past reports
 *   GET    /api/scans/:id           status + report
 *   GET    /api/scans/:id/events    live progress (Server-Sent Events)
 *   POST   /api/suppressions        mark a finding as not a problem
 *   DELETE /api/suppressions        undo that
 *
 * Run from apps/backend: pnpm exec tsx src/server/server.ts   (PORT, default 4100)
 */
const PORT = Number(process.env.PORT ?? 4100);
const REASONS: SuppressionReason[] = [
  "false-positive",
  "intended-behaviour",
  "wont-fix",
];
const manager = new ScanManager(createLlmClient());

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}") as T;
}

function isHttpUrl(value: unknown): value is string {
  try {
    return ["http:", "https:"].includes(new URL(String(value)).protocol);
  } catch {
    return false;
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const parts = pathname.split("/").filter(Boolean);

  if (req.method === "GET" && pathname === "/api/health")
    return send(res, 200, { ok: true, busy: manager.isBusy() });

  if (pathname === "/api/scans" && req.method === "POST") {
    const body = await readJson<ScanRequest>(req);
    if (!isHttpUrl(body.baseUrl))
      return send(res, 400, { error: "baseUrl must be an http(s) URL" });
    if (manager.isBusy())
      return send(res, 409, { error: "A scan is already running" });
    const id = manager.start({
      ...body,
      baseUrl: new URL(body.baseUrl).origin,
    });
    return send(res, 202, { id });
  }

  if (pathname === "/api/scans" && req.method === "GET")
    return send(res, 200, manager.history());

  if (
    parts[0] === "api" &&
    parts[1] === "scans" &&
    parts[2] &&
    req.method === "GET"
  ) {
    const id = parts[2];

    if (parts[3] === "events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const unsubscribe = manager.subscribe(id, (event) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.type !== "progress") res.end();
      });
      if (!unsubscribe) {
        const status = manager.status(id);
        res.write(
          status
            ? `event: done\ndata: ${JSON.stringify({ type: "done", reportId: id })}\n\n`
            : 'event: failed\ndata: {"error":"unknown scan"}\n\n',
        );
        return void res.end();
      }
      req.on("close", unsubscribe);
      return;
    }

    const status = manager.status(id);
    return status
      ? send(res, 200, status)
      : send(res, 404, { error: "unknown scan" });
  }

  if (
    pathname === "/api/suppressions" &&
    (req.method === "POST" || req.method === "DELETE")
  ) {
    const body = await readJson<{
      target?: string;
      key?: string;
      reason?: SuppressionReason;
      note?: string;
    }>(req);
    if (!body.target || !body.key)
      return send(res, 400, { error: "target and key are required" });
    if (req.method === "DELETE") {
      unsuppress(body.target, body.key);
      return send(res, 200, { ok: true });
    }
    if (!body.reason || !REASONS.includes(body.reason))
      return send(res, 400, {
        error: `reason must be one of ${REASONS.join(", ")}`,
      });
    return send(
      res,
      200,
      suppress(body.target, body.key, body.reason, body.note),
    );
  }

  send(res, 404, { error: "not found" });
}

createServer((req, res) => {
  handle(req, res).catch((err) =>
    send(res, 500, { error: err instanceof Error ? err.message : String(err) }),
  );
}).listen(PORT, () =>
  console.log(`AI App Tester API on http://localhost:${PORT}`),
);
