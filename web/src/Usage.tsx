import { useCallback, useEffect, useState } from "react";
import { admin, fmtMs, fmtN, fmtUsd, type DemoConfig } from "./api";

export function Usage({ cfg }: { cfg: DemoConfig }) {
  const [usage, setUsage] = useState<any[]>([]);
  const [reqs, setReqs] = useState<any[]>([]);
  const [filter, setFilter] = useState("");
  const [detail, setDetail] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([
        admin(cfg.adminToken, "/admin/usage"),
        admin(cfg.adminToken, `/admin/requests?limit=100${filter ? `&tenant=${filter}` : ""}`),
      ]);
      setUsage(u);
      setReqs(r);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, [cfg.adminToken, filter]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="page">
      {err && <div className="banner error">{err}</div>}
      <section className="panel">
        <h3>Tenants – this billing period <button className="ghost" onClick={refresh}>↻</button></h3>
        <table className="tbl">
          <thead>
            <tr>
              <th>Tenant</th><th>Plan</th><th>Requests</th><th>Tokens used</th><th>Remaining quota</th><th>Est. cost</th><th>Outcomes</th><th></th>
            </tr>
          </thead>
          <tbody>
            {usage.map((u) => (
              <tr key={u.tenant}>
                <td><b>{u.tenant}</b><div className="small muted">{u.name}</div></td>
                <td>{u.plan}<div className="small muted">{u.allowedTiers.join(", ")}</div></td>
                <td>{fmtN(u.requestsUsed)} / {fmtN(u.requestQuota)}</td>
                <td>{fmtN(u.tokensUsed)}{u.tokensReserved ? <span className="small muted"> (+{u.tokensReserved} in flight)</span> : null}</td>
                <td style={{ minWidth: 200 }}>
                  <Quota used={u.tokenQuota - u.tokensRemaining} total={u.tokenQuota} />
                  <div className="small muted">{fmtN(u.tokensRemaining)} tokens · {fmtN(u.requestsRemaining)} requests left</div>
                </td>
                <td>{fmtUsd(u.costUsd)}</td>
                <td className="small">
                  {u.outcomes.map((o: any) => (
                    <span key={o.outcome} className={`badge ${o.outcome === "success" ? "ok" : o.outcome.startsWith("refused") ? "warn" : o.outcome === "quota_exceeded" || o.outcome.startsWith("failed") ? "bad" : ""}`}>
                      {o.outcome} {o.n}
                    </span>
                  ))}
                </td>
                <td>
                  <button className="ghost small" onClick={() => admin(cfg.adminToken, `/admin/tenants/${u.tenant}/reset-quota`, { method: "POST" }).then(refresh)}>
                    reset quota
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h3>
          Recent requests
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="inline">
            <option value="">all tenants</option>
            {cfg.tenants.map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
          </select>
        </h3>
        <table className="tbl small clickable">
          <thead>
            <tr><th>Time</th><th>Tenant</th><th>Endpoint</th><th>Outcome</th><th>Backend</th><th>Fallback</th><th>Intent</th><th>Tokens</th><th>Latency</th><th>TTFT</th><th>Cost</th></tr>
          </thead>
          <tbody>
            {reqs.map((r) => (
              <tr key={r.id} onClick={() => admin(cfg.adminToken, `/admin/requests/${r.id}`).then(setDetail)}>
                <td>{new Date(r.created_at).toLocaleTimeString()}</td>
                <td>{r.tenant_id}</td>
                <td className="mono">{r.endpoint}</td>
                <td><span className={`badge ${r.outcome === "success" ? "ok" : r.outcome.startsWith("refused") ? "warn" : "bad"}`}>{r.outcome}</span></td>
                <td className="mono">{r.backend ?? "–"}</td>
                <td>{r.fallback_used ? <span className="badge warn">yes</span> : ""}</td>
                <td>{r.intent ?? ""}</td>
                <td>{fmtN(r.prompt_tokens + r.completion_tokens)} <span className="muted">{r.usage_source === "estimated" ? "est" : ""}</span></td>
                <td>{fmtMs(r.latency_ms)}</td>
                <td>{fmtMs(r.ttft_ms)}</td>
                <td>{fmtUsd(r.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {detail && (
        <div className="drawer" onClick={() => setDetail(null)}>
          <div className="drawer-body" onClick={(e) => e.stopPropagation()}>
            <h3>{detail.id} <button className="ghost" onClick={() => setDetail(null)}>✕</button></h3>
            <div className="small">
              <b>{detail.outcome}</b> · {detail.tenant_id} · {detail.endpoint} · {detail.error_code && <span className="badge bad">{detail.error_code}</span>} {detail.error_message}
            </div>
            {detail.route_reason && (
              <div className="block">
                <div className="bt">Routing decision</div>
                <span className="badge">{detail.route_reason.rule}</span> {detail.route_reason.reason}
                <div className="mono small">{detail.route_reason.chain.join(" → ")}</div>
                <pre className="small">{JSON.stringify(detail.route_reason.signals, null, 2)}</pre>
              </div>
            )}
            <div className="block">
              <div className="bt">Attempts</div>
              <table className="tbl small">
                <thead><tr><th>#</th><th>Backend</th><th>Outcome</th><th>Latency</th><th>TTFT</th><th>Tokens in/out</th><th>Usage</th><th>Cost</th></tr></thead>
                <tbody>
                  {detail.attempts.map((a: any) => (
                    <tr key={a.id}>
                      <td>{a.seq}</td><td className="mono">{a.backend}</td>
                      <td><span className={`badge ${a.outcome === "ok" ? "ok" : "bad"}`}>{a.outcome}</span>{a.error && <div className="muted">{a.error}</div>}</td>
                      <td>{fmtMs(a.latency_ms)}</td><td>{fmtMs(a.ttft_ms)}</td>
                      <td>{a.prompt_tokens}/{a.completion_tokens}</td><td>{a.usage_source}</td><td>{fmtUsd(a.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <pre className="small">{JSON.stringify({ ...detail, attempts: undefined, route_reason: undefined }, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function Quota({ used, total }: { used: number; total: number }) {
  const p = total ? Math.min(1, used / total) : 1;
  return (
    <div className="bar">
      <div style={{ width: `${p * 100}%` }} className={p > 0.9 ? "low" : p > 0.6 ? "mid" : "ok"} />
      <span>{Math.round(p * 100)}%</span>
    </div>
  );
}
