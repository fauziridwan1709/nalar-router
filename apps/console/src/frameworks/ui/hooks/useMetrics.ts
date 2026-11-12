/** Shared data for the Monitor pages: one metrics call per (range, tenant, backend), refreshed while visible. */
import { useCallback, useEffect, useState } from "react";
import { useApi } from "./api";
import type { Range, Metrics } from "../../../entities/models";

export function useMetrics(range: Range, tenant: string, backend: string) {
  const api = useApi();
  const [m, setM] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setM(await api.metrics({ range, tenant, backend }));
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
