/** Shared data for the Monitor pages: one metrics call per (range, tenant, backend), refreshed while visible. */
import { useCallback, useEffect, useState } from "react";
import { api, qs } from "./api";
import type { Group } from "./ui";
import type { ParetoRow } from "./charts";
import type { Range } from "./kit";

export interface GroupTotals {
  requests: number;
  tokens: number;
  costUsd: number;
}
export interface Bucket {
  t: number;
  requests: number;
  outcomes: Record<Group, number>;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  modelCalls: number;
  fallbacks: number;
  fallbackRate: number | null;
  p50: number | null;
  p95: number | null;
  byBackend: Record<string, GroupTotals>;
  byTenant: Record<string, GroupTotals>;
}
export interface Metrics {
  range: Range;
  bucketMs: number;
  totals: {
    requests: number;
    successRate: number | null;
    tokens: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    modelCalls: number;
    fallbackRate: number | null;
    p50: number | null;
    p95: number | null;
    outcomes: Record<Group, number>;
    piiRequests: number;
    piiByType: Record<string, number>;
  };
  buckets: Bucket[];
  byTenant: { tenant: string; requests: number; tokens: number; costUsd: number }[];
  byBackend: { backend: string; requests: number; share: number }[];
  paretoIntents: ParetoRow[];
  paretoIssues: ParetoRow[];
}

export function useMetrics(range: Range, tenant: string, backend: string) {
  const [m, setM] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setM(await api<Metrics>(`/api/console/metrics${qs({ range, tenant, backend })}`));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [range, tenant, backend]);
  useEffect(() => {
    load();
    const t = setInterval(load, range === "1h" ? 10_000 : 30_000);
    return () => clearInterval(t);
  }, [load, range]);
  return { m, loading, err, reload: load };
}

export function timeLabel(range: Range) {
  return (t: number) => {
    const d = new Date(t);
    if (range === "30d") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (range === "7d") return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${String(d.getHours()).padStart(2, "0")}h`;
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
}

/** backend → categorical slot, fixed by identity (never by rank) */
export const BACKEND_COLOR: Record<string, { color: string; ink: string }> = {
  "groq-fast": { color: "var(--s1)", ink: "#ffffff" },
  "groq-strong": { color: "var(--s2)", ink: "#ffffff" },
  "local-qwen": { color: "var(--s3)", ink: "#ffffff" },
  mock: { color: "var(--s4)", ink: "#0b0b0b" },
  "no model call": { color: "var(--axis)", ink: "#ffffff" },
};
/** tenants get slots by their fixed position in the tenant list, so a filter never repaints them */
export const tenantColor = (ids: string[], id: string) => ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"][ids.indexOf(id)] ?? "var(--axis)";

export const pct = (v: number | null) => (v == null ? "–" : `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`);
