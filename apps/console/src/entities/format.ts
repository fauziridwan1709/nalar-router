/** Display formatting for numbers, money, durations, shares and time buckets. Pure. */
import type { Range } from "./models";

/** dollars, with enough decimals that a fraction of a cent still shows */
export function fmtUsd(usd: number | null | undefined) {
  if (usd == null) return "–";
  if (usd === 0) return "$0";
  return usd < 0.01 ? `$${usd.toFixed(6)}` : `$${usd.toFixed(4)}`;
}
export const fmtMs = (x: number | null | undefined) =>
  x == null ? "–" : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x} ms`;
export const fmtN = (x: number | null | undefined) => (x == null ? "–" : x.toLocaleString());
export const pct = (v: number | null) => (v == null ? "–" : `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`);

/** a code from the gateway, for reading: "refused_low_confidence" → "refused low confidence" */
export const humanize = (code: string) => code.replace(/_/g, " ");

/** a tenant's display name without its note: "Acme Corp (pro demo)" → "Acme Corp" */
export const shortName = (tenantName: string) => tenantName.split(" (")[0];

export function timeLabel(range: Range) {
  return (t: number) => {
    const d = new Date(t);
    if (range === "30d") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (range === "7d")
      return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${String(d.getHours()).padStart(2, "0")}h`;
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
}
