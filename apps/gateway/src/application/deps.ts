/**
 * What the use cases need from the outside world, as one contract. The composition root
 * (gateway.ts) builds an object that satisfies it; tests build one with fakes. Use cases never
 * see the database, Express or the config loader directly.
 */
import type { CircuitBreaker } from "../domain/routing/breaker.js";
import type { RouteOptions } from "../domain/routing/policy.js";
import type { Bm25Index } from "../domain/support/retrieval.js";
import type { PromptVersion } from "../domain/support/prompt.js";
import type { Backend } from "./ports/backend.js";
import type { MeteringStore, QuotaStore } from "./ports/stores.js";

export interface SupportSettings {
  topK: number;
  /** retrieved entries shown to the model */
  contextK: number;
  /** below this lexical coverage a short message is out of scope (no model call) */
  minCoverage: number;
  /** the coverage gate applies only to messages with at most this many terms */
  gateMaxTerms: number;
  /** final confidence below this → refuse instead of answering */
  refuseBelow: number;
  maxAnswerTokens: number;
  reasoningExtraTokens: number;
  defaultPromptVersion: PromptVersion;
}

export interface ClassifierSettings {
  /** the backend that classifies for auto-smart; falls back to the first enabled fast-tier backend */
  backendId: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface AppDeps {
  config: { routing: RouteOptions; support: SupportSettings; classifier: ClassifierSettings };
  backends: Backend[];
  breaker: CircuitBreaker;
  kb: Bm25Index;
  intents: string[];
  quota: QuotaStore;
  metering: MeteringStore;
}
