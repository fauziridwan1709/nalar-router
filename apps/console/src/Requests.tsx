import { useCallback, useEffect, useMemo, useState } from "react";
import { admin, fmtMs, fmtN, fmtUsd, type DemoConfig } from "./api";
import { GROUP, Outcome, RouteStrip, groupOf, type Group } from "./ui";

export function Requests({ cfg }: { cfg: DemoConfig }) {
  const [rows, setRows] = useState<any[]>([]);
  const [tenant, setTenant] = useState("");
  const [group, setGroup] = useState<"" | Group>("");
  const [onlyFallback, setOnlyFallback] = useState(false);
  const [detail, setDetail] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await admin(cfg.adminToken, `/admin/requests?limit=300${tenant ? `&tenant=${tenant}` : ""}`));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, [cfg.adminToken, tenant]);
  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [load]);

  const shown = useMemo(
    () => rows.filter((r) => (!group || groupOf(r.outcome) === group) && (!onlyFallback || r.fallback_used)),
    [rows, group, onlyFallback],
  );

  return (
    <>
      <div className="filters">
        <select value={tenant} onChange={(e) => setTenant(e.target.value)} aria-label="Tenant">
          <option value="">All tenants</option>
          {cfg.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select value={group} onChange={(e) => setGroup(e.target.value as Group | "")} aria-label="Outcome">
          <option value="">All outcomes</option>
          {(Object.keys(GROUP) as Group[]).map((g) => <option key={g} value={g}>{GROUP[g].label}</option>)}
        </select>
        <label className="check small">
          <input type="checkbox" checked={onlyFallback} onChange={(e) => setOnlyFallback(e.target.checked)} /> Only requests that fell back
        </label>
        <span className="muted small">{fmtN(shown.length)} of the latest {fmtN(rows.length)}</span>
      </div>
      {err && <div className="banner error">{err}</div>}

      <section className="panel" style={{ overflow: "auto" }}>
        <table className="tbl click">
          <thead>
            <tr>
              <th>Time</th><th>Tenant</th><th>Outcome</th><th>Route (attempts in order)</th><th>Intent</th>
              <th className="r">Tokens</th><th className="r">Latency</th><th className="r">First token</th><th className="r">Cost</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} onClick={() => admin(cfg.adminToken, `/admin/requests/${r.id}`).then(setDetail)} tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && admin(cfg.adminToken, `/admin/requests/${r.id}`).then(setDetail)}>
                <td className="num">{new Date(r.created_at).toLocaleTimeString()}</td>
                <td>{r.tenant_id}</td>
                <td><Outcome outcome={r.outcome} /></td>
                <td><RouteStrip trail={r.attempt_trail} /></td>
                <td className="small">{r.intent ?? <span className="muted">–</span>}</td>
                <td className="r">
                  {fmtN(r.prompt_tokens + r.completion_tokens)}
                  {r.usage_source === "estimated" && <span className="muted small"> est.</span>}
                </td>
                <td className="r">{fmtMs(r.latency_ms)}</td>
                <td className="r">{fmtMs(r.ttft_ms)}</td>
                <td className="r">{fmtUsd(r.cost_usd)}</td>
              </tr>
            ))}
            {!shown.length && (
              <tr><td colSpan={9} className="muted" style={{ padding: 24, textAlign: "center" }}>No requests match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {detail && <RequestDrawer detail={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

export function RequestDrawer({ detail, onClose }: { detail: any; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const trail = detail.attempts.map((a: any) => `${a.backend}:${a.outcome}`).join(",");
  return (
    <div className="drawer" onClick={onClose}>
      <div className="drawer-body" role="dialog" aria-label={`Request ${detail.id}`} onClick={(e) => e.stopPropagation()}>
        <h3>
          <span className="mono">{detail.id}</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={onClose}>Close</button>
        </h3>
        <div className="filters small" style={{ marginBottom: 10 }}>
          <Outcome outcome={detail.outcome} />
          <span className="tag">{detail.tenant_id}</span>
          <span className="tag">{detail.endpoint}</span>
          {detail.error_code && <span className="tag bad">{detail.error_code}</span>}
          <span className="muted">{new Date(detail.created_at).toLocaleString()}</span>
        </div>
        {detail.error_message && <div className="banner small" style={{ marginBottom: 10 }}>{detail.error_message}</div>}
        <div className="section">
          <h4>Route</h4>
          <RouteStrip trail={trail} />
        </div>
        {detail.route_reason && (
          <div className="section">
            <h4>Routing decision</h4>
            <div><span className="tag accent">{detail.route_reason.rule}</span> {detail.route_reason.reason}</div>
            <div className="mono small muted" style={{ marginTop: 4 }}>planned chain: {detail.route_reason.chain.join(" › ")}</div>
            <pre>{JSON.stringify(detail.route_reason.signals, null, 2)}</pre>
          </div>
        )}
        <div className="section">
          <h4>Attempts</h4>
          <table className="tbl">
            <thead><tr><th>#</th><th>Backend</th><th>Outcome</th><th className="r">Latency</th><th className="r">First token</th><th className="r">Tokens in / out</th><th>Usage</th><th className="r">Cost</th></tr></thead>
            <tbody>
              {detail.attempts.map((a: any) => (
                <tr key={a.id}>
                  <td>{a.seq}</td>
                  <td className="mono">{a.backend}</td>
                  <td>
                    <span className={`tag ${a.outcome === "ok" ? "good" : a.outcome === "refused" ? "warn" : "bad"}`}>{a.outcome.replace(/_/g, " ")}</span>
                    {a.error && <div className="muted small">{a.error}</div>}
                  </td>
                  <td className="r">{fmtMs(a.latency_ms)}</td>
                  <td className="r">{fmtMs(a.ttft_ms)}</td>
                  <td className="r">{fmtN(a.prompt_tokens)} / {fmtN(a.completion_tokens)}</td>
                  <td>{a.usage_source}</td>
                  <td className="r">{fmtUsd(a.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="section">
          <h4>Metered record</h4>
          <pre>{JSON.stringify({ ...detail, attempts: undefined, route_reason: undefined }, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}
