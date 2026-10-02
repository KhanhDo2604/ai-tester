import { join } from "path";
import { CachedLlmClient } from "./cachedClient";
import { OllamaClient } from "./ollamaClient";
import { LlmClient } from "./types";

/**
 * Builds the LLM client from environment variables:
 *
 *   LLM_PROVIDER   "ollama" (default) or "none"
 *   LLM_MODEL      model name, default "qwen3:8b"
 *   OLLAMA_URL     default "http://127.0.0.1:11434"
 *   LLM_CACHE      "off" disables the answer cache
 *
 * "none" returns undefined: the engine then runs without any LLM, and
 * every step that needs one reports itself as skipped instead of guessing.
 *
 * Adding a hosted provider later means one more branch here plus one more
 * LlmClient implementation; nothing that calls the client changes.
 */
export function createLlmClient(): LlmClient | undefined {
  const provider = (process.env.LLM_PROVIDER ?? "ollama").toLowerCase();
  if (provider === "none") return undefined;

  let client: LlmClient;
  switch (provider) {
    case "ollama":
      client = new OllamaClient({
        baseUrl: process.env.OLLAMA_URL,
        model: process.env.LLM_MODEL ?? "qwen3:8b",
      });
      break;
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${provider}". Supported: ollama, none.`,
      );
  }

  if ((process.env.LLM_CACHE ?? "").toLowerCase() === "off") return client;
  return new CachedLlmClient(
    client,
    join(process.cwd(), ".ai-tester-cache", "llm-answers.json"),
  );
}
