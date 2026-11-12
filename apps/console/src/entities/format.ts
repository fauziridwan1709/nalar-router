/** Display formatting for numbers, money, durations, shares and time buckets. Pure. */
import type { Range } from "./models";

export const fmtUsd = (x: number | null | undefined) =>
  x == null ? "–" : x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(6)}` : `$${x.toFixed(4)}`;
export const fmtMs = (x: number | null | undefined) => (x == null ? "–" : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x} ms`);
export const fmtN = (x: number | null | undefined) => (x == null ? "–" : x.toLocaleString());
export const pct = (v: number | null) => (v == null ? "–" : `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`);

export function timeLabel(range: Range) {
  return (t: number) => {
    const d = new Date(t);
    if (range === "30d") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (range === "7d") return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${String(d.getHours()).padStart(2, "0")}h`;
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
}
