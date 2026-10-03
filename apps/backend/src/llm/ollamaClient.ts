import { LlmClient, LlmRequest, LlmStats } from "./types";

const RETRY_DELAYS_MS = [2000, 5000];

class RetryableError extends Error {}

export interface OllamaOptions {
  /** Defaults to http://127.0.0.1:11434. */
  baseUrl?: string;
  model: string;
  /** Per-request timeout. A small model on CPU can take a while on the first call while it loads. */
  timeoutMs?: number;
}

/**
 * Talks to a local Ollama server through its native /api/chat endpoint.
 *
 * - `format` carries the JSON schema, so Ollama constrains generation to
 *   valid JSON of exactly that shape. For small models this matters more
 *   than raw capability: the engine must be able to parse every answer.
 * - `think: false` turns off the "thinking" phase of reasoning models such
 *   as Qwen3. The questions asked here are short classification tasks, and
 *   thinking would multiply latency without improving the answer.
 * - temperature 0 makes the same question give the same answer, which
 *   keeps scans reproducible and makes caching meaningful.
 */
export class OllamaClient implements LlmClient {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private calls = 0;

  constructor(options: OllamaOptions) {
    // 127.0.0.1 rather than "localhost": Node 17+ may resolve "localhost" to
    // the IPv6 address ::1 first, while Ollama listens on IPv4 127.0.0.1 by
    // default — the connection is then refused even though Ollama is running.
    this.baseUrl = (options.baseUrl || "http://127.0.0.1:11434").replace(
      /\/$/,
      "",
    );
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.name = `ollama/${this.model}`;
  }

  /**
   * Retries crashes and refused connections: Ollama restarts a crashed model
   * process on the next request, so one failure shouldn't cost a finding.
   * Timeouts and bad answers are not retried.
   */
  async completeJson<T>(request: LlmRequest): Promise<T> {
    this.calls++;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt<T>(request);
      } catch (err) {
        if (
          !(err instanceof RetryableError) ||
          attempt >= RETRY_DELAYS_MS.length
        )
          throw err;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  private async attempt<T>(request: LlmRequest): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          format: request.schema,
          options: { temperature: 0 },
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
        }),
      });
    } catch (err) {
      // Node's fetch hides the real reason (ECONNREFUSED, ENOTFOUND, ...) in err.cause.
      const cause = (err as { cause?: { code?: string; message?: string } })
        ?.cause;
      const reason = controller.signal.aborted
        ? `timed out after ${this.timeoutMs} ms`
        : `${String(err)}${cause ? ` (${cause.code ?? cause.message})` : ""}`;
      const message = `Ollama request failed (${this.baseUrl}, model ${this.model}): ${reason}. Is "ollama serve" running?`;
      throw controller.signal.aborted
        ? new Error(message)
        : new RetryableError(message);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const message = `Ollama returned ${response.status}: ${body.slice(0, 300)}`;
      throw response.status >= 500
        ? new RetryableError(message)
        : new Error(message);
    }

    const data = (await response.json()) as { message?: { content?: string } };
    const content = data.message?.content ?? "";
    try {
      return JSON.parse(content) as T;
    } catch {
      throw new Error(
        `Model answer was not valid JSON: ${content.slice(0, 300)}`,
      );
    }
  }

  stats(): LlmStats {
    return { calls: this.calls, cacheHits: 0 };
  }
}
