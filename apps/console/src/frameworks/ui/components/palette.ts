/** Chart colours: categorical slots from the validated dataviz palette (styles.css s1–s4). */
/** backend → categorical slot, fixed by identity (never by rank) */
export const BACKEND_COLOR: Record<string, { color: string; ink: string }> = {
  "groq-fast": { color: "var(--s1)", ink: "#ffffff" },
  "groq-strong": { color: "var(--s2)", ink: "#ffffff" },
  "local-qwen3.5-4b": { color: "var(--s3)", ink: "#ffffff" },
  mock: { color: "var(--s4)", ink: "#0b0b0b" },
  "no model call": { color: "var(--axis)", ink: "#ffffff" },
};
/** tenants get slots by their fixed position in the tenant list, so a filter never repaints them */
export const tenantColor = (ids: string[], id: string) => ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"][ids.indexOf(id)] ?? "var(--axis)";
