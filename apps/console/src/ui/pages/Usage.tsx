import { useState } from "react";
import { ChartPanel, Legend, StackedColumns, TableView } from "../components/charts";
import { FilterChip, PageHeader, RANGES, StatCard, asOf } from "../components/kit";
import { useApp } from "../../application/appContext";
import { useMetrics } from "../../application/useMetrics";
import { BACKEND_COLOR, tenantColor } from "../components/palette";
import { GROUP } from "../components/ui";
import type { Group, Range, Bucket } from "../../domain/models";
import { fmtN, timeLabel } from "../../domain/format";

/** the tenant / backend chips every Monitor page shares */
export function MonitorChips({ backend, setBackend, groupBy, setGroupBy, groupOptions }: {
  backend: string;
  setBackend: (b: string) => void;
  groupBy?: string;
  setGroupBy?: (g: string) => void;
  groupOptions?: { value: string; label: string }[];
}) {
  const { cfg, can, scope, setScope } = useApp();
  return (
    <div className="chips" role="group" aria-label="Filters for every chart on this page">
      {can("tenants:all") && (
        <FilterChip label="Tenant" value={scope || "*"} onChange={(v) => setScope(v === "*" ? "" : v)} tour="scope"
          options={[{ value: "*", label: "All" }, ...cfg.tenants.map((t) => ({ value: t.id, label: t.name.split(" (")[0], description: `${t.plan} plan` }))]} />
      )}
      <FilterChip label="Backend" value={backend || "*"} onChange={(v) => setBackend(v === "*" ? "" : v)}
        options={[{ value: "*", label: "All" }, ...cfg.backends.map((b) => ({ value: b.id, label: b.id, description: `${b.tier} tier` }))]} />
      {groupBy && setGroupBy && groupOptions && (
        <>
          <span className="sep" />
          <FilterChip label="Group by" value={groupBy} onChange={setGroupBy} options={groupOptions} />
        </>
      )}
    </div>
  );
}

export const RangeChip = ({ range, setRange }: { range: Range; setRange: (r: Range) => void }) => (
  <FilterChip label="Range" value={range} onChange={(v) => setRange(v as Range)} options={RANGES} />
);

export function Usage() {
  const { cfg, scope, tenantName } = useApp();
  const [range, setRange] = useState<Range>("7d");
  const [backend, setBackend] = useState("");
  const [groupBy, setGroupBy] = useState<"backend" | "tenant">("backend");
  const { m, loading, err } = useMetrics(range, scope, backend);
  const fmtTime = timeLabel(range);
  const tenantIds = cfg.tenants.map((t) => t.id);
  const keys = [...new Set((m?.buckets ?? []).flatMap((b) => Object.keys(groupBy === "backend" ? b.byBackend : b.byTenant)))].sort();
  const colorOf = (k: string) => (groupBy === "backend" ? BACKEND_COLOR[k]?.color ?? "var(--axis)" : tenantColor(tenantIds, k));
  const labelOf = (k: string) => (groupBy === "tenant" ? tenantName(k) : k);
  const groups = Object.keys(GROUP) as Group[];
  const tot = m?.totals;

  return (
    <>
      <PageHeader title="Usage" sub={<>Token and request volume over time, including failed attempts. Data as of {asOf()}.</>} actions={<RangeChip range={range} setRange={setRange} />} />
      <MonitorChips backend={backend} setBackend={setBackend} groupBy={groupBy} setGroupBy={(g) => setGroupBy(g as "backend" | "tenant")}
        groupOptions={[{ value: "backend", label: "Backend" }, { value: "tenant", label: "Tenant" }]} />
      <p className="note">Includes every request metered for the tenants you can see, from the API and the console playground.</p>
      {err && <div className="banner error">{err}</div>}

      <div className="grid c3">
        <StatCard k="Total tokens in" value={tot?.promptTokens ?? null} fmt={(v) => fmtN(Math.round(v))} info="Prompt tokens across every attempt, including attempts that fell back" />
        <StatCard k="Total tokens out" value={tot?.completionTokens ?? null} fmt={(v) => fmtN(Math.round(v))} info="Completion tokens, including reasoning tokens the provider bills" />
        <StatCard k="Requests" value={tot?.requests ?? null} fmt={(v) => fmtN(Math.round(v))} sub={tot ? `${fmtN(tot.modelCalls)} reached a model` : undefined} />
      </div>

      {m && (
        <>
          <ChartPanel
            title="Token usage"
            sub={`Prompt + completion tokens per ${m.bucketMs >= 86_400_000 ? "day" : m.bucketMs >= 3_600_000 ? `${m.bucketMs / 3_600_000} h` : `${m.bucketMs / 60_000} min`}, by ${groupBy}`}
            legend={<Legend shape="rect" items={keys.map((k) => ({ label: labelOf(k), color: colorOf(k) }))} />}
            table={<TableView rows={m.buckets} cols={[{ label: "Time", get: (b: Bucket) => fmtTime(b.t) }, ...keys.map((k) => ({ label: labelOf(k), get: (b: Bucket) => fmtN((groupBy === "backend" ? b.byBackend : b.byTenant)[k]?.tokens ?? 0) }))]} />}
          >
            <StackedColumns data={m.buckets} x={(b) => b.t} xLabel={fmtTime} loading={loading} height={260}
              format={(v) => (v >= 1e4 ? `${+(v / 1e3).toFixed(1)}K` : fmtN(v))}
              series={keys.map((k) => ({ key: k, label: labelOf(k), color: colorOf(k), get: (b: Bucket) => (groupBy === "backend" ? b.byBackend : b.byTenant)[k]?.tokens ?? 0 }))} />
          </ChartPanel>
          <ChartPanel
            title="Requests by outcome"
            sub="Every request, whether or not it reached a model"
            legend={<Legend shape="rect" items={groups.map((g) => ({ label: GROUP[g].label, color: GROUP[g].color }))} />}
            table={<TableView rows={m.buckets} cols={[{ label: "Time", get: (b: Bucket) => fmtTime(b.t) }, ...groups.map((g) => ({ label: GROUP[g].label, get: (b: Bucket) => b.outcomes[g] }))]} />}
          >
            <StackedColumns data={m.buckets} x={(b) => b.t} xLabel={fmtTime} loading={loading} height={220} format={(v) => fmtN(v)}
              series={groups.map((g) => ({ key: g, label: GROUP[g].label, color: GROUP[g].color, get: (b: Bucket) => b.outcomes[g] }))} />
          </ChartPanel>
        </>
      )}
    </>
  );
}
