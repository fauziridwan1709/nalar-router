import type { ReactNode } from "react";

export type Group = "success" | "refused" | "rejected" | "failed";

export function groupOf(outcome: string): Group {
  if (outcome === "success") return "success";
  if (outcome.startsWith("refused")) return "refused";
  if (outcome === "quota_exceeded" || outcome === "rejected") return "rejected";
  return "failed";
}

/** outcome groups use the reserved status palette, always with an icon + a text label */
export const GROUP: Record<Group, { label: string; color: string; icon: ReactNode }> = {
  success: { label: "Answered", color: "var(--good)", icon: <Icon d="M3 8.5l3 3 7-7" /> },
  refused: { label: "Refused / handed off", color: "var(--warning)", icon: <Icon d="M4 12L12 4M8 14A6 6 0 108 2a6 6 0 000 12z" /> },
  rejected: { label: "Rejected (quota, input)", color: "var(--serious)", icon: <Icon d="M4 8h8M8 14A6 6 0 108 2a6 6 0 000 12z" /> },
  failed: { label: "Failed", color: "var(--critical)", icon: <Icon d="M4 4l8 8M12 4l-8 8" /> },
};

export function Icon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Outcome({ outcome }: { outcome: string }) {
  const g = GROUP[groupOf(outcome)];
  return (
    <span className="state" title={g.label}>
      <span style={{ color: g.color }}>{g.icon}</span>
      {outcome.replace(/_/g, " ")}
    </span>
  );
}

/** the attempt trail of one request: failed hops struck through, the serving hop outlined */
export function RouteStrip({ trail }: { trail: string | null | undefined }) {
  if (!trail) return <span className="muted small">no model call</span>;
  const hops = trail.split(",").map((h) => {
    const i = h.lastIndexOf(":");
    return { backend: h.slice(0, i), outcome: h.slice(i + 1) };
  });
  return (
    <span className="route" aria-label={hops.map((h) => `${h.backend} ${h.outcome}`).join(", then ")}>
      {hops.map((h, i) => (
        <span key={i} style={{ display: "contents" }}>
          {i > 0 && <span className="arrow">›</span>}
          <span
            className={`hop ${h.outcome === "ok" ? "ok" : h.outcome === "skipped_circuit_open" ? "skip" : h.outcome === "refused" ? "refused" : "fail"}`}
            title={`${h.backend}: ${h.outcome.replace(/_/g, " ")}`}
          >
            {h.backend}
          </span>
        </span>
      ))}
    </span>
  );
}

export const NAV_ICONS = {
  overview: "M2 13h12M4 13V8M8 13V3M12 13V6",
  playground: "M3 3h10v7H8l-3 3v-3H3z",
  requests: "M3 4h10M3 8h10M3 12h6",
  tenants: "M5.5 7a2 2 0 100-4 2 2 0 000 4zM2 13c0-2 1.6-3.5 3.5-3.5S9 11 9 13M11 7.5a1.6 1.6 0 100-3.2M11.5 9.5c1.4.3 2.5 1.6 2.5 3.5",
  backends: "M3 3h10v4H3zM3 9h10v4H3zM5.5 5h.01M5.5 11h.01",
  evaluations: "M3 13V9M7 13V5M11 13V7M2 13.5h12M10 3l1.5 1.5L14 2",
  sun: "M8 11a3 3 0 100-6 3 3 0 000 6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1",
  moon: "M13 9.5A5.5 5.5 0 016.5 3 5.5 5.5 0 1013 9.5z",
};

export function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <rect width="28" height="28" rx="7" fill="var(--accent)" />
      <path d="M7 14h5M15 14c3 0 3-6 6-6M15 14c3 0 3 6 6 6M15 14h6" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <circle cx="13.5" cy="14" r="2" fill="#fff" />
    </svg>
  );
}
