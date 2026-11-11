/**
 * Shared domain vocabulary: the plain data types the business rules talk about. No behaviour,
 * no I/O. Outer layers (config loading, SQLite rows, HTTP bodies) map into these.
 */
import type { PiiPolicy } from "./guardrails/pii.js";

/**
 * All tunables live in config.ts so routing/pricing decisions are reviewable in one place.
 * Prices are USD per 1M tokens, list prices at build time, used only for *estimated* cost.
 */
export type Tier = "fast" | "strong" | "local" | "degraded";

export interface BackendConfig {
  id: string;
  /** where the model runs: shown in the console next to the online/offline label */
  location: "cloud" | "local" | "built-in";
  kind: "openai-compatible" | "mock";
  tier: Tier;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** provider-specific body fields (e.g. reasoning_effort) */
  extraBody?: Record<string, unknown>;
  /** body fields that switch reasoning output on / off for this provider */
  reasoningBody?: { on: Record<string, unknown>; off: Record<string, unknown> };
  priceInPerM: number;
  priceOutPerM: number;
  /** abort and fall back if no first token by then */
  firstTokenTimeoutMs: number;
  /** abort the whole call after this */
  totalTimeoutMs: number;
  enabled: boolean;
}

export interface Tenant {
  id: string;
  name: string;
  plan: string;
  allowedTiers: Tier[];
  tokenQuota: number;
  requestQuota: number;
  quotaResetAt: number;
  profile: Record<string, string>;
  piiPolicy: PiiPolicy;
}

/** one chat turn, after the HTTP layer has normalised OpenAI's variants (text parts, `developer`) */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** anything the router can put in a chain: it only needs the backend's configuration */
export interface RoutableBackend {
  readonly config: BackendConfig;
}
