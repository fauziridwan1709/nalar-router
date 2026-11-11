/**
 * Shared console UI. Interactive controls come from the Astryx design system (Selector,
 * DropdownMenu, Dialog, Tooltip, Toast…); icons are Lucide, the set Astryx's neutral theme uses.
 * Status is never colour alone: an icon and a word go with it.
 */
import { useState, type ReactNode } from "react";
import { Selector } from "@astryxdesign/core/Selector";
import { useToast } from "@astryxdesign/core/Toast";
import {
  Activity, BarChart3, Boxes, Check, CircleAlert, CircleCheck, CircleMinus, CircleX, Coins, Copy, FlaskConical, Gauge, House, KeyRound,
  ListTree, MessageSquareText, ScrollText, ServerCog, ShieldCheck, Users, type LucideIcon,
} from "lucide-react";

export type Group = "success" | "refused" | "rejected" | "failed";

export function groupOf(outcome: string): Group {
  if (outcome === "success") return "success";
  if (outcome.startsWith("refused")) return "refused";
  if (outcome === "quota_exceeded" || outcome === "rejected") return "rejected";
  return "failed";
}

/** outcome groups use the reserved status palette, always with an icon + a text label */
export const GROUP: Record<Group, { label: string; color: string; Icon: LucideIcon }> = {
  success: { label: "Answered", color: "var(--good)", Icon: CircleCheck },
  refused: { label: "Refused / handed off", color: "var(--warning)", Icon: CircleAlert },
  rejected: { label: "Rejected (quota, input)", color: "var(--serious)", Icon: CircleMinus },
  failed: { label: "Failed", color: "var(--critical)", Icon: CircleX },
};

export const NAV: Record<string, LucideIcon> = {
  dashboard: House,
  playground: MessageSquareText,
  keys: KeyRound,
  usage: BarChart3,
  cost: Coins,
  reliability: Activity,
  logs: ListTree,
  quotas: Gauge,
  guardrails: ShieldCheck,
  access: Users,
  audit: ScrollText,
  backends: ServerCog,
  evaluations: FlaskConical,
  boxes: Boxes,
};

export function Outcome({ outcome }: { outcome: string }) {
  const g = GROUP[groupOf(outcome)];
  return (
    <span className="state" title={g.label}>
      <g.Icon size={14} color={g.color} aria-hidden />
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

export interface Option {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

/** the Astryx Selector, with the props this console uses */
export function Select({
  label, value, onChange, options, hideLabel = true, size = "sm", width, search, variant = "input", tour, disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  hideLabel?: boolean;
  size?: "sm" | "md";
  width?: number | string;
  search?: boolean;
  variant?: "input" | "secondary" | "ghost";
  tour?: string;
  disabled?: boolean;
}) {
  return (
    <div className="select" data-tour={tour} style={width ? { width } : undefined}>
      <Selector
        label={label}
        isLabelHidden={hideLabel}
        size={size}
        variant={variant}
        value={value}
        onChange={(v) => onChange(v)}
        options={options}
        hasSearch={search}
        isDisabled={disabled}
        width="100%"
      />
    </div>
  );
}

export function CopyButton({ text, label = "Copy", what = "Copied to clipboard" }: { text: string; label?: string; what?: string }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          toast({ body: what, type: "info" });
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast({ body: "Couldn't copy. Select the text and copy it by hand.", type: "error" });
        }
      }}
    >
      {done ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      {done ? "Copied" : label}
    </button>
  );
}

export function Empty({ icon: I, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {I && (
        <div className="empty-icon">
          <I size={20} aria-hidden />
        </div>
      )}
      <b>{title}</b>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export const ROLE_LABEL: Record<string, string> = { operator: "Operator", owner: "Owner", developer: "Developer", viewer: "Viewer" };

/** the mark: a router fan-out drawn as a spark, in the brand terracotta */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ color: "var(--brand)", flex: "none" }}>
      {[0, 30, 60, 90, 120, 150].map((a) => (
        <rect key={a} x="11" y="2" width="2" height="20" rx="1" fill="currentColor" transform={`rotate(${a} 12 12)`} opacity={a % 60 ? 0.75 : 1} />
      ))}
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}

export const timeAgo = (t: number | null | undefined) => {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
