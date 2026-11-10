/**
 * Time-bucketed aggregates for the console dashboard, computed from the same `requests`
 * table that metering and quota use, so the charts can never disagree with billing.
 */
import type { DB } from "./db.js";

export const RANGES = {
  "15m": { spanMs: 15 * 60_000, bucketMs: 60_000 },
  "1h": { spanMs: 60 * 60_000, bucketMs: 5 * 60_000 },
  "24h": { spanMs: 24 * 3_600_000, bucketMs: 3_600_000 },
  "7d": { spanMs: 7 * 86_400_000, bucketMs: 6 * 3_600_000 },
} as const;
export type RangeKey = keyof typeof RANGES;

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
}

export function computeMetrics(db: DB, range: RangeKey, opts: { tenantId?: string; now?: number } = {}) {
  const { spanMs, bucketMs } = RANGES[range];
  const now = opts.now ?? Date.now();
  // align buckets to wall-clock boundaries so labels read 10:00, 10:05, …
  const end = Math.ceil((now + 1) / bucketMs) * bucketMs;
  const start = end - spanMs;
  const rows = (
    opts.tenantId
      ? db.prepare(
          `SELECT created_at, tenant_id, outcome, backend, fallback_used, prompt_tokens, completion_tokens, latency_ms, cost_usd
             FROM requests WHERE created_at >= ? AND created_at < ? AND outcome != 'in_progress' AND tenant_id = ?`,
        ).all(start, end, opts.tenantId)
      : db.prepare(
          `SELECT created_at, tenant_id, outcome, backend, fallback_used, prompt_tokens, completion_tokens, latency_ms, cost_usd
             FROM requests WHERE created_at >= ? AND created_at < ? AND outcome != 'in_progress'`,
        ).all(start, end)
  ) as unknown as Row[];

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
    _lat: [] as number[],
  }));

  const byTenant = new Map<string, { requests: number; tokens: number; costUsd: number }>();
  const byBackend = new Map<string, number>();
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
    const t = byTenant.get(r.tenant_id) ?? { requests: 0, tokens: 0, costUsd: 0 };
    t.requests++;
    t.tokens += tokens;
    t.costUsd += r.cost_usd;
    byTenant.set(r.tenant_id, t);
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
    byBackend: [...byBackend.entries()].map(([backend, requests]) => ({ backend, requests, share: requests / (modelCalls || 1) })),
  };
}
