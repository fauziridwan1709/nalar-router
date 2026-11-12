import type { BackendConfig, ChatMessage } from "../../entities/types.js";
export type { ChatMessage };


export interface Sampling {
  top_p?: number;
  stop?: string | string[];
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
}

export interface BackendRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  signal: AbortSignal;
  /** OpenAI sampling parameters from the raw chat path; OpenAI-compatible backends forward them, the mock ignores them */
  sampling?: Sampling;
  /** stream the model's reasoning ("thinking") as separate chunks, if the backend supports it */
  includeReasoning?: boolean;
  /**
   * Capability-specific hints. The mock backend uses `extractive` to produce a
   * grounded, retrieval-only answer (degraded mode); real models ignore it.
   */
  hints?: { extractive?: { intent: string; answer: string; confidence: number } };
}

export type StreamChunk =
  | { type: "text"; text: string }
  /** model reasoning; never part of the answer, never parsed, only shown for transparency */
  | { type: "reasoning"; text: string }
  | { type: "usage"; promptTokens: number; completionTokens: number };

export interface Backend {
  readonly config: BackendConfig;
  stream(req: BackendRequest): AsyncIterable<StreamChunk>;
}
