/** Page building blocks: a page header (title, context, actions), "Label Value ▾" filter chips, and stat cards. */
import type { ReactNode } from "react";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Check, ChevronDown, Info } from "lucide-react";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { Sparkline, useCountUp } from "./charts";
import type { Range } from "../../../entities/models";
import type { Page } from "../../../entities/access";

export function PageHeader({ title, sub, actions, serif, tour }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; serif?: boolean; tour?: string }) {
  return (
    <div className="page-head" data-tour={tour}>
      <div>
        <h1 className={serif ? "serif" : undefined}>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export interface ChipOption {
  value: string;
  label: string;
  description?: string;
}

/** a filter chip: "Tenant All ▾", opens an Astryx menu with the choices, the current one checked */
export function FilterChip({ label, value, options, onChange, tour }: { label: string; value: string; options: ChipOption[]; onChange: (v: string) => void; tour?: string }) {
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <DropdownMenu
      menuWidth={240}
      menuMaxHeight={360}
      renderTrigger={(p) => (
        <button {...p} type="button" className="chip" data-tour={tour} aria-label={`${label}: ${current?.label}`}>
          <span className="lbl">{label}</span>
          <span>{current?.label}</span>
          <ChevronDown size={14} aria-hidden />
        </button>
      )}
      items={options.map((o) => ({
        label: o.label,
        description: o.description,
        endContent: o.value === value ? <Check size={14} aria-label="selected" /> : undefined,
        onClick: () => onChange(o.value),
      }))}
    />
  );
}

export function StatCard({ k, value, fmt, sub, info, trend, extra }: {
  k: string;
  value: number | null;
  fmt: (v: number) => string;
  sub?: ReactNode;
  info?: string;
  trend?: (number | null)[];
  extra?: ReactNode;
}) {
  const v = useCountUp(value ?? 0);
  return (
    <div className="card stat-card">
      <div className="k">
        {k}
        {info && (
          <Tooltip content={info}>
            <span tabIndex={0} aria-label={info} style={{ display: "inline-flex" }}><Info size={14} /></span>
          </Tooltip>
        )}
        {extra && <span style={{ marginLeft: "auto" }}>{extra}</span>}
      </div>
      <div className="row">
        <div>
          <div className="v num">{value == null ? "–" : fmt(v)}</div>
          {sub && <div className="d">{sub}</div>}
        </div>
        {trend && trend.length > 1 && <Sparkline values={trend} />}
      </div>
    </div>
  );
}

/** the range chip every monitor page puts on the right, like "Range Last 30 days" */
export const RANGES: ChipOption[] = [
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

export const asOf = () =>
  new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
