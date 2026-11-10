import type { BackendConfig } from "../config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface BackendRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  signal: AbortSignal;
  /**
   * Capability-specific hints. The mock backend uses `extractive` to produce a
   * grounded, retrieval-only answer (degraded mode); real models ignore it.
   */
  hints?: { extractive?: { intent: string; answer: string; confidence: number } };
}

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "usage"; promptTokens: number; completionTokens: number };

export interface Backend {
  readonly config: BackendConfig;
  stream(req: BackendRequest): AsyncIterable<StreamChunk>;
}
