import { useEffect, useState } from "react";
import { admin, type BackendStatus } from "./api";
import { Icon } from "./ui";

/** polls /admin/backends so labels reflect probes + circuit breaker */
export function useBackendStatus(adminToken: string, everyMs = 10_000) {
  const [list, setList] = useState<BackendStatus[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => admin<BackendStatus[]>(adminToken, "/admin/backends").then((l) => alive && setList(l)).catch(() => {});
    load();
    const t = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [adminToken, everyMs]);
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
  const d = s.label === "online" ? "M3 8.5l3 3 7-7" : s.label === "degraded" ? "M8 4v5M8 12h.01" : "M4 4l8 8M12 4l-8 8";
  return (
    <span className="state" title={s.reason}>
      <span style={{ color: s.color }}><Icon d={d} /></span>
      {s.label === "online" ? "Online" : s.label === "degraded" ? "Degraded" : "Offline"}
    </span>
  );
}

export const LOCATION_LABEL: Record<string, string> = { cloud: "Cloud", local: "On-device", "built-in": "Built-in" };
