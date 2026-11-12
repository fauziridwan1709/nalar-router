/**
 * Time-bucketed aggregates for the console dashboard, computed from the same `requests`
 * table that metering and quota use, so the charts can never disagree with billing.
 */
import type { DatabaseSync as DB } from "node:sqlite";
import { RANGES, type RangeKey } from "../../../entities/reporting.js";
export { RANGES, type RangeKey };

/** outcomes grouped into the four states a dashboard reader cares about */
export function outcomeGroup(outcome: string): "success" | "refused" | "rejected" | "failed" {
  if (outcome === "success") return "success";
  if (outcome.startsWith("refused")) return "refused";
  if (outcome === "quota_exceeded" || outcome === "rejected") return "rejected";
  return "failed"; // failed_all_backends, partial, internal_error, client_aborted, interrupted
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

interface Row {
  created_at: number;
  tenant_id: string;
  outcome: string;
  backend: string | null;
  fallback_used: number;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number | null;
  cost_usd: number;
  intent: string | null;
  error_code: string | null;
  pii: string | null;
}

/** a readable cause for every request that wasn't answered: feeds the "where do problems come from" Pareto */
export function issueOf(r: Pick<Row, "outcome" | "error_code">): string | null {
  if (r.outcome === "success") return null;
  if (r.outcome === "refused_out_of_scope") return "Out of scope (refused)";
  if (r.outcome === "refused_low_confidence") return "Low confidence (refused)";
  if (r.outcome === "quota_exceeded") return "Quota exceeded";
  if (r.outcome === "rejected") return r.error_code === "model_not_allowed" ? "Model not on plan" : "Invalid request";
  if (r.outcome === "failed_all_backends") return "All backends failed";
  if (r.outcome === "partial") return "Stream interrupted";
  if (r.outcome === "client_aborted") return "Client cancelled";
  return "Other failure";
}

/** sorted descending with each item's share and the running cumulative share (one 0–100% axis) */
function pareto(counts: Map<string, number>, maxItems = 8) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const head = sorted.slice(0, maxItems);
  const rest = sorted.slice(maxItems).reduce((n, [, v]) => n + v, 0);
  if (rest) head.push(["Other", rest]);
  let cum = 0;
  return head.map(([label, count]) => {
    cum += count;
    return { label, count, share: total ? count / total : 0, cumulative: total ? cum / total : 0 };
  });
}

type Group = { requests: number; tokens: number; costUsd: number };
const addToMap = (m: Map<string, Group>, k: string, tokens: number, cost: number) => {
  const g = m.get(k) ?? { requests: 0, tokens: 0, costUsd: 0 };
  g.requests++;
  g.tokens += tokens;
  g.costUsd += cost;
  m.set(k, g);
};
const addTo = (m: Record<string, Group>, k: string, tokens: number, cost: number) => {
  const g = (m[k] ??= { requests: 0, tokens: 0, costUsd: 0 });
  g.requests++;
  g.tokens += tokens;
  g.costUsd += cost;
};

export function computeMetrics(db: DB, range: RangeKey, opts: { tenantId?: string; backend?: string; now?: number } = {}) {
  const { spanMs, bucketMs } = RANGES[range];
  const now = opts.now ?? Date.now();
  // align buckets to wall-clock boundaries so labels read 10:00, 10:05, …
  const end = Math.ceil((now + 1) / bucketMs) * bucketMs;
  const start = end - spanMs;
  const allRows = (
    opts.tenantId
      ? db.prepare(
          `SELECT created_at, tenant_id, outcome, backend, fallback_used, prompt_tokens, completion_tokens, latency_ms, cost_usd, intent, error_code, pii
             FROM requests WHERE created_at >= ? AND created_at < ? AND outcome != 'in_progress' AND tenant_id = ?`,
        ).all(start, end, opts.tenantId)
      : db.prepare(
          `SELECT created_at, tenant_id, outcome, backend, fallback_used, prompt_tokens, completion_tokens, latency_ms, cost_usd, intent, error_code, pii
             FROM requests WHERE created_at >= ? AND created_at < ? AND outcome != 'in_progress'`,
        ).all(start, end)
  ) as unknown as Row[];
  const rows = opts.backend ? allRows.filter((r) => r.backend === opts.backend) : allRows;

  const n = Math.round(spanMs / bucketMs);
  const buckets = Array.from({ length: n }, (_, i) => ({
    t: start + i * bucketMs,
    requests: 0,
    outcomes: { success: 0, refused: 0, rejected: 0, failed: 0 },
    tokens: 0,
    costUsd: 0,
    modelCalls: 0,
    fallbacks: 0,
    p50: null as number | null,
    p95: null as number | null,
    promptTokens: 0,
    completionTokens: 0,
    byBackend: {} as Record<string, Group>,
    byTenant: {} as Record<string, Group>,
    _lat: [] as number[],
  }));
  let piiRequests = 0;
  const piiByType: Record<string, number> = {};

  const byTenant = new Map<string, { requests: number; tokens: number; costUsd: number }>();
  const byBackend = new Map<string, number>();
  const byIntent = new Map<string, number>();
  const byIssue = new Map<string, number>();
  const allLat: number[] = [];
  let fallbacks = 0;
  let modelCalls = 0;

  for (const r of rows) {
    const b = buckets[Math.min(n - 1, Math.floor((r.created_at - start) / bucketMs))];
    const tokens = r.prompt_tokens + r.completion_tokens;
    b.requests++;
    b.outcomes[outcomeGroup(r.outcome)]++;
    b.tokens += tokens;
    b.costUsd += r.cost_usd;
    b.promptTokens += r.prompt_tokens;
    b.completionTokens += r.completion_tokens;
    addTo(b.byBackend, r.backend ?? "no model call", tokens, r.cost_usd);
    addTo(b.byTenant, r.tenant_id, tokens, r.cost_usd);
    if (r.pii) {
      piiRequests++;
      for (const part of r.pii.split(",")) {
        const [t, n] = part.split(":");
        piiByType[t] = (piiByType[t] ?? 0) + Number(n || 0);
      }
    }
    // latency/fallback only mean something for requests that reached a model
    if (r.backend) {
      b.modelCalls++;
      modelCalls++;
      if (r.fallback_used) {
        b.fallbacks++;
        fallbacks++;
      }
      if (r.latency_ms != null) {
        b._lat.push(r.latency_ms);
        allLat.push(r.latency_ms);
      }
      byBackend.set(r.backend, (byBackend.get(r.backend) ?? 0) + 1);
    }
    if (r.intent && r.intent !== "unknown") byIntent.set(r.intent, (byIntent.get(r.intent) ?? 0) + 1);
    const issue = issueOf(r);
    if (issue) byIssue.set(issue, (byIssue.get(issue) ?? 0) + 1);
    addToMap(byTenant, r.tenant_id, tokens, r.cost_usd);
  }
  for (const b of buckets) {
    b._lat.sort((x, y) => x - y);
    b.p50 = percentile(b._lat, 0.5);
    b.p95 = percentile(b._lat, 0.95);
  }
  allLat.sort((x, y) => x - y);
  const success = rows.filter((r) => r.outcome === "success").length;

  return {
    range,
    bucketMs,
    start,
    end,
    totals: {
      requests: rows.length,
      successRate: rows.length ? success / rows.length : null,
      tokens: rows.reduce((s, r) => s + r.prompt_tokens + r.completion_tokens, 0),
      promptTokens: rows.reduce((s, r) => s + r.prompt_tokens, 0),
      completionTokens: rows.reduce((s, r) => s + r.completion_tokens, 0),
      piiRequests,
      piiByType,
      costUsd: rows.reduce((s, r) => s + r.cost_usd, 0),
      modelCalls,
      fallbackRate: modelCalls ? fallbacks / modelCalls : null,
      p50: percentile(allLat, 0.5),
      p95: percentile(allLat, 0.95),
      outcomes: rows.reduce(
        (m, r) => ((m[outcomeGroup(r.outcome)] += 1), m),
        { success: 0, refused: 0, rejected: 0, failed: 0 },
      ),
    },
    buckets: buckets.map(({ _lat, ...b }) => ({ ...b, fallbackRate: b.modelCalls ? b.fallbacks / b.modelCalls : null })),
    byTenant: [...byTenant.entries()].map(([tenant, v]) => ({ tenant, ...v })).sort((a, b) => b.costUsd - a.costUsd),
    paretoIntents: pareto(byIntent),
    paretoIssues: pareto(byIssue),
    byBackend: [...byBackend.entries()].map(([backend, requests]) => ({ backend, requests, share: requests / (modelCalls || 1) })),
  };
}
