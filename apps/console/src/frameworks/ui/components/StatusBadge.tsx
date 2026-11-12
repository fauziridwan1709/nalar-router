import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { backendState } from "../../../entities/backends";
export { useBackendStatus } from "../hooks/useBackendStatus";
export { LOCATION_LABEL } from "../../../entities/backends";
import type { BackendStatus } from "../../../entities/models";

/** "online" / "offline", with "degraded" when the breaker is open on an online backend */
export function statusOf(b: BackendStatus) {
  const s = backendState(b);
  return {
    ...s,
    color: s.label === "online" ? "var(--good)" : s.label === "degraded" ? "var(--warning)" : "var(--critical)",
  };
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
