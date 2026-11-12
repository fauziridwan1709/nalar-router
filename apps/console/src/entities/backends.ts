/** What the console says about a backend's availability. */
import type { BackendStatus } from "./models";

export type BackendLabel = "online" | "degraded" | "offline";

/** the probe's online/offline, with "degraded" when the circuit breaker is open on an online backend */
export function backendState(b: BackendStatus): { label: BackendLabel; reason: string } {
  const label = b.health?.label ?? (b.enabled ? "online" : "offline");
  if (label === "online" && b.breaker?.state === "open") return { label: "degraded", reason: "circuit breaker open" };
  return { label, reason: b.health?.reason ?? "" };
}

export const LOCATION_LABEL: Record<string, string> = { cloud: "Cloud", local: "On-device", "built-in": "Built-in" };
