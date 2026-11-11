import { useState } from "react";
import { fmtN, fmtUsd } from "./api";
import { ChartPanel, HBars, Legend, StackedColumns, TableView } from "./charts";
import { PageHeader, StatCard, asOf, type Range } from "./kit";
import { useApp } from "./context";
import { BACKEND_COLOR, tenantColor, timeLabel, useMetrics, type Bucket } from "./metricsData";
import { MonitorChips, RangeChip } from "./Usage";

const money = (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : v === 0 ? "$0" : `$${+v.toPrecision(2)}`);

export function Cost() {
  const { cfg, scope, tenantName, can } = useApp();
  const [range, setRange] = useState<Range>("7d");
  const [backend, setBackend] = useState("");
  const [groupBy, setGroupBy] = useState<"backend" | "tenant">(can("tenants:all") ? "tenant" : "backend");
  const { m, loading, err } = useMetrics(range, scope, backend);
  const fmtTime = timeLabel(range);
  const tenantIds = cfg.tenants.map((t) => t.id);
  const keys = [...new Set((m?.buckets ?? []).flatMap((b) => Object.keys(groupBy === "backend" ? b.byBackend : b.byTenant)))]
    .filter((k) => k !== "no model call")
    .sort();
  const colorOf = (k: string) => (groupBy === "backend" ? BACKEND_COLOR[k]?.color ?? "var(--axis)" : tenantColor(tenantIds, k));
  const labelOf = (k: string) => (groupBy === "tenant" ? tenantName(k) : k);
  const tot = m?.totals;

  return (
    <>
      <PageHeader title="Cost" sub={<>Estimated spend from metered tokens and list prices in the gateway config. Data as of {asOf()}.</>} actions={<RangeChip range={range} setRange={setRange} />} />
      <MonitorChips backend={backend} setBackend={setBackend} groupBy={groupBy} setGroupBy={(g) => setGroupBy(g as "backend" | "tenant")}
        groupOptions={[{ value: "backend", label: "Backend" }, { value: "tenant", label: "Tenant" }]} />
      <p className="note">Failed attempts that consumed tokens are real spend and are included. Local and built-in backends cost $0.</p>
      {err && <div className="banner error">{err}</div>}

      <div className="grid c3">
        <StatCard k="Total cost" value={tot?.costUsd ?? null} fmt={money} info="Estimated, not an invoice: tokens × list price per backend" />
        <StatCard k="Cost per 1,000 requests" value={tot && tot.requests ? (tot.costUsd / tot.requests) * 1000 : null} fmt={money} />
        <StatCard k="Cost per 1M tokens" value={tot && tot.tokens ? (tot.costUsd / tot.tokens) * 1e6 : null} fmt={money} sub={tot ? `${fmtN(tot.tokens)} tokens` : undefined} />
      </div>

      {m && (
        <>
          <ChartPanel
            title="Token cost"
            sub={`Estimated cost per ${m.bucketMs >= 86_400_000 ? "day" : m.bucketMs >= 3_600_000 ? `${m.bucketMs / 3_600_000} h` : `${m.bucketMs / 60_000} min`}, by ${groupBy}`}
            legend={<Legend shape="rect" items={keys.map((k) => ({ label: labelOf(k), color: colorOf(k) }))} />}
            table={<TableView rows={m.buckets} cols={[{ label: "Time", get: (b: Bucket) => fmtTime(b.t) }, ...keys.map((k) => ({ label: labelOf(k), get: (b: Bucket) => fmtUsd((groupBy === "backend" ? b.byBackend : b.byTenant)[k]?.costUsd ?? 0) }))]} />}
          >
            <StackedColumns data={m.buckets} x={(b) => b.t} xLabel={fmtTime} loading={loading} height={260} format={money}
              series={keys.map((k) => ({ key: k, label: labelOf(k), color: colorOf(k), get: (b: Bucket) => (groupBy === "backend" ? b.byBackend : b.byTenant)[k]?.costUsd ?? 0 }))} />
          </ChartPanel>
          {can("tenants:all") && !scope && (
            <ChartPanel title="Cost by tenant" sub="Who is spending, ranked"
              table={<TableView rows={m.byTenant} cols={[{ label: "Tenant", get: (r) => tenantName(r.tenant) }, { label: "Requests", get: (r) => fmtN(r.requests) }, { label: "Tokens", get: (r) => fmtN(r.tokens) }, { label: "Cost", get: (r) => fmtUsd(r.costUsd) }]} />}>
              {m.byTenant.length ? (
                <HBars format={fmtUsd} rows={m.byTenant.map((r) => ({ label: tenantName(r.tenant), value: r.costUsd, sub: `${fmtN(r.requests)} requests · ${fmtN(r.tokens)} tokens` }))} />
              ) : <div className="muted small pad">No spend in this range.</div>}
            </ChartPanel>
          )}
        </>
      )}
    </>
  );
}
