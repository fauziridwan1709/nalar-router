/** How request outcomes are grouped for charts and badges. */
import type { Group } from "./models";

export function groupOf(outcome: string): Group {
  if (outcome === "success") return "success";
  if (outcome.startsWith("refused")) return "refused";
  if (outcome === "quota_exceeded" || outcome === "rejected") return "rejected";
  return "failed";
}
