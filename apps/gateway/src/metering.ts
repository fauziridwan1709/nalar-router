/**
 * Writes the final per-request metering row and its attempts, and releases the quota
 * reservation, in one transaction. Request totals are the SUM over attempts: a failed
 * attempt that consumed tokens is real spend and counts against quota.
 */
import type { DB } from "./db.js";
import type { AttemptRecord } from "./router/executor.js";

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

export function finishRequest(db: DB, requestId: string, f: FinalRecord, attempts: AttemptRecord[]): MeterSummary {
  const s = summarize(attempts);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE requests SET finished_at=?, outcome=?, http_status=?, backend=?, model=?, route_reason=?, fallback_used=?,
         prompt_tokens=?, completion_tokens=?, usage_source=?, latency_ms=?, ttft_ms=?, cost_usd=?, intent=?, confidence=?,
         error_code=?, error_message=?
       WHERE id=?`,
    ).run(
      Date.now(), f.outcome, f.httpStatus, f.backend ?? null, f.model ?? null,
      f.routeReason === undefined ? null : JSON.stringify(f.routeReason),
      s.fallbackUsed ? 1 : 0, s.promptTokens, s.completionTokens, s.usageSource,
      Math.round(f.latencyMs), f.ttftMs == null ? null : Math.round(f.ttftMs), s.costUsd,
      f.intent ?? null, f.confidence ?? null, f.errorCode ?? null, f.errorMessage ?? null, requestId,
    );
    const ins = db.prepare(
      `INSERT INTO attempts (request_id, seq, backend, model, started_at, outcome, error, latency_ms, ttft_ms,
         prompt_tokens, completion_tokens, usage_source, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const a of attempts) {
      ins.run(requestId, a.seq, a.backend, a.model, a.startedAt, a.outcome, a.error ?? null, Math.round(a.latencyMs),
        a.ttftMs == null ? null : Math.round(a.ttftMs), a.promptTokens, a.completionTokens, a.usageSource, a.costUsd);
    }
    db.prepare("DELETE FROM reservations WHERE request_id = ?").run(requestId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return s;
}

/** Requests rejected after auth but before admission (bad input, model not allowed). Never count against quota. */
export function recordRejected(db: DB, requestId: string, tenantId: string, endpoint: string, status: number, code: string, message: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO requests (id, tenant_id, endpoint, created_at, finished_at, outcome, http_status, error_code, error_message, counts_against_quota, latency_ms)
     VALUES (?, ?, ?, ?, ?, 'rejected', ?, ?, ?, 0, 0)`,
  ).run(requestId, tenantId, endpoint, now, now, status, code, message.slice(0, 500));
}

export function getRequestDetail(db: DB, id: string) {
  const r = db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as any;
  if (!r) return null;
  const attempts = db.prepare("SELECT * FROM attempts WHERE request_id = ? ORDER BY seq").all(id);
  return { ...r, route_reason: r.route_reason ? JSON.parse(r.route_reason) : null, attempts };
}

// "backend:outcome,backend:outcome" in attempt order: the route strip in the console
const TRAIL = `(SELECT group_concat(backend || ':' || outcome, ',') FROM
  (SELECT backend, outcome FROM attempts a WHERE a.request_id = r.id ORDER BY seq)) AS attempt_trail`;

export function listRequests(db: DB, opts: { tenantId?: string; limit?: number }) {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 50));
  const rows = opts.tenantId
    ? db.prepare(`SELECT r.*, ${TRAIL} FROM requests r WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`).all(opts.tenantId, limit)
    : db.prepare(`SELECT r.*, ${TRAIL} FROM requests r ORDER BY created_at DESC LIMIT ?`).all(limit);
  return rows.map((r: any) => ({ ...r, route_reason: r.route_reason ? JSON.parse(r.route_reason) : null }));
}
