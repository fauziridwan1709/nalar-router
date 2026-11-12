/**
 * Metering vocabulary and arithmetic: what one attempt and one request cost. Pure; the SQLite
 * adapter in interface-adapters/gateways/sqlite/metering.ts stores these.
 */
import { estimateMessagesTokens, estimateTokens } from "./tokens.js";

export type AttemptOutcome =
  | "ok"
  | "error"
  | "timeout_first_token"
  | "timeout_total"
  | "unusable_output"
  | "skipped_circuit_open"
  | "aborted"
  | "refused"
  /** auto-cascade: the fast model's header was unsure, so the request moved up to the strong tier (not a failure) */
  | "escalated"
  /** auto-smart: the router's own classification call, made before any answer attempt */
  | "classified";

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

export type UsageSource = AttemptRecord["usageSource"];

/**
 * Token usage for one model call: what the provider reported if it did; otherwise an estimate
 * (chars/4, which reads a little high); and nothing for a call the provider rejected outright,
 * which isn't billed. The mock backend's "usage" is its own estimate, so it is labelled as one.
 */
export function attemptUsage(call: {
  reported: { promptTokens: number; completionTokens: number } | null;
  isMock: boolean;
  /** the provider rejected the call before producing anything (HTTP error, connection refused) */
  rejected: boolean;
  promptText: { content: string }[];
  produced: string;
  reasoned: string;
}): { promptTokens: number; completionTokens: number; usageSource: UsageSource } {
  if (call.reported) return { ...call.reported, usageSource: call.isMock ? "estimated" : "provider" };
  if (call.rejected) return { promptTokens: 0, completionTokens: 0, usageSource: "none" };
  return {
    promptTokens: estimateMessagesTokens(call.promptText),
    // reasoning tokens are billed too
    completionTokens: estimateTokens(call.produced) + estimateTokens(call.reasoned),
    usageSource: "estimated",
  };
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
    // fallback = anything other than the first planned backend produced/ended the request. The
    // router's classification call and a planned cascade escalation are routing, not fallback.
    fallbackUsed: attempts.filter((a) => a.outcome !== "classified" && a.outcome !== "escalated").length > 1,
  };
}

