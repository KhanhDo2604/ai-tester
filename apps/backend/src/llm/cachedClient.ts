import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { LlmClient, LlmRequest, LlmStats } from "./types";

/**
 * Wraps any LlmClient with a persistent answer cache on disk.
 *
 * The key is a hash of the model name plus the full request (system
 * prompt, user message, schema). The same control on the same app asks
 * exactly the same question on every scan, so after the first scan those
 * questions cost nothing. Changing the prompt or the model changes the
 * key, so a stale answer is never reused for a different question.
 */
export class CachedLlmClient implements LlmClient {
  readonly name: string;
  private readonly cache: Record<string, unknown>;
  private hits = 0;

  constructor(
    private readonly inner: LlmClient,
    private readonly cacheFile: string,
  ) {
    this.name = inner.name;
    this.cache = existsSync(cacheFile)
      ? JSON.parse(readFileSync(cacheFile, "utf8"))
      : {};
  }

  async completeJson<T>(request: LlmRequest): Promise<T> {
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          this.inner.name,
          request.system,
          request.user,
          request.schema,
        ]),
      )
      .digest("hex");

    if (key in this.cache) {
      this.hits++;
      return this.cache[key] as T;
    }

    const answer = await this.inner.completeJson<T>(request);
    this.cache[key] = answer;
    this.persist();
    return answer;
  }

  stats(): LlmStats {
    return { calls: this.inner.stats().calls, cacheHits: this.hits };
  }

  private persist(): void {
    mkdirSync(dirname(this.cacheFile), { recursive: true });
    writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
  }
}
