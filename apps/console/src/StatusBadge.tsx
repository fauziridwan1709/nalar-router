import { useEffect, useState } from "react";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { api, type BackendStatus } from "./api";

/** polls the backend list so labels reflect probes + circuit breaker */
export function useBackendStatus(everyMs = 10_000) {
  const [list, setList] = useState<BackendStatus[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api<BackendStatus[]>("/api/console/backends").then((l) => alive && setList(l)).catch(() => {});
    load();
    const t = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [everyMs]);
  return list;
}

/** "online" / "offline", with "degraded" when the breaker is open on an online backend */
export function statusOf(b: BackendStatus) {
  const label = b.health?.label ?? (b.enabled ? "online" : "offline");
  if (label === "online" && b.breaker?.state === "open") return { label: "degraded", color: "var(--warning)", reason: "circuit breaker open" };
  return { label, color: label === "online" ? "var(--good)" : "var(--critical)", reason: b.health?.reason ?? "" };
}

/** status is never color alone: icon + word */
export function StatusBadge({ b }: { b: BackendStatus }) {
  const s = statusOf(b);
  const I = s.label === "online" ? CircleCheck : s.label === "degraded" ? TriangleAlert : CircleX;
  return (
    <span className="state" title={s.reason}>
      <I size={14} color={s.color} aria-hidden />
      {s.label === "online" ? "Online" : s.label === "degraded" ? "Degraded" : "Offline"}
    </span>
  );
}

export const LOCATION_LABEL: Record<string, string> = { cloud: "Cloud", local: "On-device", "built-in": "Built-in" };
