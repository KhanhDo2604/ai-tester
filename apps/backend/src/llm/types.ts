/**
 * One structured request to a language model. Every LLM use in the engine
 * goes through this shape: a fixed system instruction, a small user
 * message built from compact context, and a JSON schema the answer must
 * follow. Free-form text answers are never parsed.
 */
export interface LlmRequest {
  system: string;
  user: string;
  /** JSON Schema the response must conform to. */
  schema: Record<string, unknown>;
}

export interface LlmStats {
  /** Requests that actually reached the model. */
  calls: number;
  /** Requests answered from the local cache without calling the model. */
  cacheHits: number;
}

/**
 * The only thing the rest of the engine knows about language models.
 * Switching from a local model to a hosted one means adding another
 * implementation of this interface, not touching discovery or contracts.
 */
export interface LlmClient {
  /** Human-readable "provider/model", for reports. */
  readonly name: string;
  completeJson<T>(request: LlmRequest): Promise<T>;
  stats(): LlmStats;
}
