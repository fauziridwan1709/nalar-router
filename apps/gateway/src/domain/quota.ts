/**
 * The quota rules, without the database: the billing period and whether a request may start.
 * infrastructure/db/quota.ts applies them inside one IMMEDIATE transaction, so two concurrent
 * requests can't both spend the last tokens.
 */
import type { Tenant } from "./types.js";

/** below this many tokens of completion budget a request is not worth admitting */
export const MIN_COMPLETION_TOKENS = 64;

export function periodBounds(now: number, tenant: Pick<Tenant, "quotaResetAt">) {
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start: Math.max(monthStart, tenant.quotaResetAt), end: monthEnd };
}

export interface Usage {
  periodStart: number;
  periodEnd: number;
  tokensUsed: number;
  tokensReserved: number;
  requestsUsed: number;
  tokenQuota: number;
  requestQuota: number;
  tokensRemaining: number;
  requestsRemaining: number;
  costUsd: number;
}


export type AdmissionDecision =
  | { admitted: true; promptEst: number; maxCompletionTokens: number }
  | { admitted: false; message: string };

/**
 * A request is admitted only if a request is left and the tokens left cover its prompt plus a
 * minimum answer. Its completion budget is then capped to what is left, so one request can't
 * run far past the quota.
 */
export function decideAdmission(usage: Usage, estimatedPromptTokens: number, requestedMaxTokens: number): AdmissionDecision {
  const promptEst = Math.max(1, estimatedPromptTokens);
  if (usage.requestsRemaining <= 0) {
    return { admitted: false, message: `Monthly request quota exhausted (${usage.requestsUsed}/${usage.requestQuota}).` };
  }
  if (usage.tokensRemaining < promptEst + MIN_COMPLETION_TOKENS) {
    return {
      admitted: false,
      message: `Monthly token quota exhausted: ${usage.tokensRemaining} tokens left, this request needs at least ${promptEst + MIN_COMPLETION_TOKENS}.`,
    };
  }
  return {
    admitted: true,
    promptEst,
    maxCompletionTokens: Math.max(MIN_COMPLETION_TOKENS, Math.min(requestedMaxTokens, usage.tokensRemaining - promptEst)),
  };
}
