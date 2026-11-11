import { useEffect, useState } from "react";
import type { BackendStatus } from "../domain/models";
import { useApi } from "./api";

/** polls the backend list so labels reflect probes + circuit breaker */
export function useBackendStatus(everyMs = 10_000) {
  const api = useApi();
  const [list, setList] = useState<BackendStatus[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.backends().then((l) => alive && setList(l)).catch(() => {});
    load();
    const t = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [everyMs]);
  return list;
}
