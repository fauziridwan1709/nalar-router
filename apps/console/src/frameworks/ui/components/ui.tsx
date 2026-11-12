/**
 * Shared console UI. Interactive controls come from the Astryx design system (Selector,
 * DropdownMenu, Dialog, Tooltip, Toast…); icons are Lucide, the set Astryx's neutral theme uses.
 * Status is never colour alone: an icon and a word go with it.
 */
import { useId, useState, type ReactNode } from "react";
import { Selector } from "@astryxdesign/core/Selector";
import { useToast } from "@astryxdesign/core/Toast";
import {
  Activity, BarChart3, Boxes, Check, CircleAlert, CircleCheck, CircleMinus, CircleX, Coins, Copy, FlaskConical, Gauge, House, KeyRound,
  ListTree, MessageSquareText, ScrollText, ServerCog, ShieldCheck, Users, type LucideIcon,
} from "lucide-react";
import type { Group } from "../../../entities/models";
import { groupOf } from "../../../entities/outcomes";



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

/** attempt outcome → hop style; anything not listed is a failure (struck through) */
const HOP_CLASS: Record<string, string> = {
  ok: "ok", skipped_circuit_open: "skip", refused: "refused",
  // routing steps, not failures: auto-smart's classifier call and an auto-cascade escalation
  classified: "router", escalated: "escalated",
};

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
            className={`hop ${HOP_CLASS[h.outcome] ?? "fail"}`}
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


/** the mark: one input fanning out to three backends, on the brand-orange gradient */
export function Logo({ size = 22 }: { size?: number }) {
  const id = `nlg${useId().replace(/[^\w-]/g, "")}`; // several logos can be on screen at once; gradient ids must not collide
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" style={{ flex: "none" }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e8916f" />
          <stop offset="1" stopColor="#c4552f" />
        </linearGradient>
      </defs>
      <rect width="28" height="28" rx="8" fill={`url(#${id})`} />
      <path d="M7 14h5M15 14c3 0 3-6 6-6M15 14c3 0 3 6 6 6M15 14h6" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <circle cx="13.5" cy="14" r="2" fill="#fff" />
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
