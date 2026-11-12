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
import type { DatabaseSync as DB } from "node:sqlite";
import type { Tenant } from "./tenants.js";
import { GatewayError } from "../../../entities/errors.js";
import { decideAdmission, periodBounds, type Usage } from "../../../entities/quota.js";
import type { AdmitInput, Admission, QuotaStore } from "../../../use-cases/ports/stores.js";
export { MIN_COMPLETION_TOKENS, periodBounds, type Usage } from "../../../entities/quota.js";
export type { AdmitInput, Admission };

/** reservations older than this are ignored (protects against leaks from crashed handlers) */
const RESERVATION_TTL_MS = 5 * 60_000;

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
    const decision = decideAdmission(usage, input.estimatedPromptTokens, input.requestedMaxTokens);
    if (!decision.admitted) {
      const denial = decision;
      db.prepare(
        `INSERT INTO requests (id, tenant_id, endpoint, created_at, finished_at, outcome, http_status, error_code, error_message, counts_against_quota, prompt_version, credential)
         VALUES (?, ?, ?, ?, ?, 'quota_exceeded', 429, 'quota_exceeded', ?, 0, ?, ?)`,
      ).run(input.requestId, tenant.id, input.endpoint, now, now, denial.message, input.promptVersion ?? null, input.credential ?? null);
      db.exec("COMMIT");
      began = false;
      throw new GatewayError(429, "quota_exceeded", denial.message, {
        tokensRemaining: usage.tokensRemaining,
        requestsRemaining: usage.requestsRemaining,
        resetsAt: new Date(usage.periodEnd).toISOString(),
      });
    }
    const { maxCompletionTokens, promptEst } = decision;
    db.prepare(
      `INSERT INTO requests (id, tenant_id, endpoint, created_at, outcome, prompt_version, credential) VALUES (?, ?, ?, ?, 'in_progress', ?, ?)`,
    ).run(input.requestId, tenant.id, input.endpoint, now, input.promptVersion ?? null, input.credential ?? null);
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
    // fail closed. The cause is logged, not returned: it is a database error, not something the caller can act on.
    console.error(`[${input.requestId}] quota check failed`, err);
    throw new GatewayError(503, "quota_unavailable", "Quota check failed; request rejected (fail-closed).");
  }
}

export function releaseReservation(db: DB, requestId: string) {
  db.prepare("DELETE FROM reservations WHERE request_id = ?").run(requestId);
}

export function resetQuota(db: DB, tenantId: string, now = Date.now()) {
  db.prepare("UPDATE tenants SET quota_reset_at = ? WHERE id = ?").run(now, tenantId);
}

/** the QuotaStore port on SQLite */
export const sqliteQuotaStore = (db: DB): QuotaStore => ({
  admit: (tenant, input) => admit(db, tenant, input),
  usage: (tenant) => getUsage(db, tenant),
  reset: (tenantId) => resetQuota(db, tenantId),
});
