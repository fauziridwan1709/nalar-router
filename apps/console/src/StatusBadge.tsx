import { useEffect, useState } from "react";
import { admin, type BackendStatus } from "./api";

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
  if (label === "online" && b.breaker?.state === "open") return { label: "degraded", cls: "warn", reason: "circuit breaker open" };
  return { label, cls: label === "online" ? "ok" : "bad", reason: b.health?.reason ?? "" };
}

export function StatusBadge({ b }: { b: BackendStatus }) {
  const s = statusOf(b);
  return (
    <span className={`status ${s.cls}`} title={s.reason}>
      <span className="dot" />
      {s.label}
    </span>
  );
}

export const LOCATION_LABEL: Record<string, string> = { cloud: "cloud", local: "on-device", "built-in": "built-in" };
