/**
 * Per-tenant monthly quota (tokens + requests).
 *
 * Design:
 *  - The `requests` table is the single source of truth for consumption; there is no
 *    separate counter that can drift from metering.
 *  - Admission is a pre-authorisation: inside one IMMEDIATE transaction we compute
 *    usage + in-flight reservations, and either insert the request row + a reservation,
 *    or reject. Concurrent requests therefore cannot both spend the last tokens.
 *  - The completion budget (max_tokens) is capped to what is left, so a single request
 *    cannot blow far past the quota.
 *  - Fails closed: if anything in this path throws, the caller gets 503
 *    `quota_unavailable` and no model is called.
 */
import type { DB } from "./db.js";
import type { Tenant } from "./tenants.js";
import { GatewayError } from "./errors.js";

/** below this many tokens of completion budget a request is not worth admitting */
export const MIN_COMPLETION_TOKENS = 64;
/** reservations older than this are ignored (protects against leaks from crashed handlers) */
const RESERVATION_TTL_MS = 5 * 60_000;

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

export function getUsage(db: DB, tenant: Tenant, now = Date.now()): Usage {
  const { start, end } = periodBounds(now, tenant);
  const u = db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens),0) AS tokens,
              COALESCE(SUM(counts_against_quota),0) AS reqs,
              COALESCE(SUM(cost_usd),0) AS cost
         FROM requests WHERE tenant_id = ? AND created_at >= ? AND created_at < ?`,
    )
    .get(tenant.id, start, end) as { tokens: number; reqs: number; cost: number };
  const r = db
    .prepare(`SELECT COALESCE(SUM(tokens),0) AS t FROM reservations WHERE tenant_id = ? AND created_at >= ?`)
    .get(tenant.id, now - RESERVATION_TTL_MS) as { t: number };
  return {
    periodStart: start,
    periodEnd: end,
    tokensUsed: u.tokens,
    tokensReserved: r.t,
    requestsUsed: u.reqs,
    tokenQuota: tenant.tokenQuota,
    requestQuota: tenant.requestQuota,
    tokensRemaining: Math.max(0, tenant.tokenQuota - u.tokens - r.t),
    requestsRemaining: Math.max(0, tenant.requestQuota - u.reqs),
    costUsd: u.cost,
  };
}

export interface AdmitInput {
  requestId: string;
  endpoint: string;
  estimatedPromptTokens: number;
  requestedMaxTokens: number;
  promptVersion?: string | null;
}

export interface Admission {
  maxCompletionTokens: number;
  usage: Usage;
}

/**
 * Atomically check quota and record the request as in_progress with a reservation.
 * Throws GatewayError(429 quota_exceeded) or GatewayError(503 quota_unavailable).
 */
export function admit(db: DB, tenant: Tenant, input: AdmitInput, now = Date.now()): Admission {
  let began = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    began = true;
    const usage = getUsage(db, tenant, now);
    const promptEst = Math.max(1, input.estimatedPromptTokens);
    let denial: { message: string } | null = null;
    if (usage.requestsRemaining <= 0) {
      denial = { message: `Monthly request quota exhausted (${usage.requestsUsed}/${usage.requestQuota}).` };
    } else if (usage.tokensRemaining < promptEst + MIN_COMPLETION_TOKENS) {
      denial = {
        message: `Monthly token quota exhausted: ${usage.tokensRemaining} tokens left, this request needs at least ${promptEst + MIN_COMPLETION_TOKENS}.`,
      };
    }
    if (denial) {
      db.prepare(
        `INSERT INTO requests (id, tenant_id, endpoint, created_at, finished_at, outcome, http_status, error_code, error_message, counts_against_quota, prompt_version)
         VALUES (?, ?, ?, ?, ?, 'quota_exceeded', 429, 'quota_exceeded', ?, 0, ?)`,
      ).run(input.requestId, tenant.id, input.endpoint, now, now, denial.message, input.promptVersion ?? null);
      db.exec("COMMIT");
      began = false;
      throw new GatewayError(429, "quota_exceeded", denial.message, {
        tokensRemaining: usage.tokensRemaining,
        requestsRemaining: usage.requestsRemaining,
        resetsAt: new Date(usage.periodEnd).toISOString(),
      });
    }
    const maxCompletionTokens = Math.max(
      MIN_COMPLETION_TOKENS,
      Math.min(input.requestedMaxTokens, usage.tokensRemaining - promptEst),
    );
    db.prepare(
      `INSERT INTO requests (id, tenant_id, endpoint, created_at, outcome, prompt_version) VALUES (?, ?, ?, ?, 'in_progress', ?)`,
    ).run(input.requestId, tenant.id, input.endpoint, now, input.promptVersion ?? null);
    db.prepare(`INSERT INTO reservations (request_id, tenant_id, tokens, created_at) VALUES (?, ?, ?, ?)`).run(
      input.requestId,
      tenant.id,
      promptEst + maxCompletionTokens,
      now,
    );
    db.exec("COMMIT");
    began = false;
    return { maxCompletionTokens, usage };
  } catch (err) {
    if (began) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
    }
    if (err instanceof GatewayError) throw err;
    // fail closed
    throw new GatewayError(503, "quota_unavailable", "Quota check failed; request rejected (fail-closed).", {
      cause: String((err as Error)?.message ?? err),
    });
  }
}

export function releaseReservation(db: DB, requestId: string) {
  db.prepare("DELETE FROM reservations WHERE request_id = ?").run(requestId);
}

export function resetQuota(db: DB, tenantId: string, now = Date.now()) {
  db.prepare("UPDATE tenants SET quota_reset_at = ? WHERE id = ?").run(now, tenantId);
}
