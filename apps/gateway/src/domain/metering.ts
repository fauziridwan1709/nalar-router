/**
 * Metering vocabulary and arithmetic: what one attempt and one request cost. Pure; the SQLite
 * adapter in infrastructure/db/metering.ts stores these.
 */

export type AttemptOutcome =
  | "ok"
  | "error"
  | "timeout_first_token"
  | "timeout_total"
  | "unusable_output"
  | "skipped_circuit_open"
  | "aborted"
  | "refused";

export interface AttemptRecord {
  seq: number;
  backend: string;
  model: string;
  startedAt: number;
  outcome: AttemptOutcome;
  error?: string;
  latencyMs: number;
  ttftMs?: number;
  promptTokens: number;
  completionTokens: number;
  usageSource: "provider" | "estimated" | "none";
  costUsd: number;
}

export interface FinalRecord {
  outcome: string;
  httpStatus: number;
  backend?: string | null;
  model?: string | null;
  routeReason?: unknown;
  latencyMs: number;
  ttftMs?: number | null;
  intent?: string | null;
  confidence?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface MeterSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageSource: "provider" | "estimated" | "mixed" | "none";
  costUsd: number;
  fallbackUsed: boolean;
}

export function summarize(attempts: AttemptRecord[]): MeterSummary {
  const promptTokens = attempts.reduce((n, a) => n + a.promptTokens, 0);
  const completionTokens = attempts.reduce((n, a) => n + a.completionTokens, 0);
  const sources = new Set(attempts.filter((a) => a.usageSource !== "none").map((a) => a.usageSource));
  const usageSource = sources.size === 0 ? "none" : sources.size > 1 ? "mixed" : ([...sources][0] as "provider" | "estimated");
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    usageSource,
    costUsd: attempts.reduce((n, a) => n + a.costUsd, 0),
    // fallback = anything other than the first planned backend produced/ended the request
    fallbackUsed: attempts.length > 1,
  };
}

