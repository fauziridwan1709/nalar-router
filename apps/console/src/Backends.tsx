import { useCallback, useEffect, useState } from "react";
import { admin, fmtMs, type DemoConfig } from "./api";
import { LOCATION_LABEL, StatusBadge } from "./StatusBadge";

const MODES = ["error", "hang", "garbage", "slow_first_token"];

export function Backends({ cfg }: { cfg: DemoConfig }) {
  const [list, setList] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(
    () => admin<any[]>(cfg.adminToken, "/admin/backends").then(setList).catch((e) => setErr(String(e))),
    [cfg.adminToken],
  );
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const setChaos = (id: string, patch: any) =>
    admin(cfg.adminToken, `/admin/chaos/${id}`, { method: "PUT", body: JSON.stringify(patch) }).then(refresh).catch((e) => setErr(String(e)));

  return (
    <div className="page">
      {err && <div className="banner error">{err}</div>}
      <section className="panel">
        <h3>
          Backends, health & fault injection
          <button className="ghost" onClick={() => admin(cfg.adminToken, "/admin/chaos", { method: "DELETE" }).then(refresh)}>clear all chaos + reset breakers</button>
        </h3>
        <p className="small muted">
          Inject failures to watch fallback in the Playground. <b>error</b> = backend returns 503 · <b>hang</b>/<b>slow_first_token</b> = no
          first token until the timeout fires · <b>garbage</b> = model returns unparseable output (tests the "unusable output" path).
          After {3} consecutive infra failures the circuit breaker skips the backend for 30 s.
        </p>
        <table className="tbl">
          <thead>
            <tr><th>Backend</th><th>Status</th><th>Tier</th><th>Model</th><th>Price in/out per 1M</th><th>Timeouts (first token / total)</th><th>Breaker</th><th>Fail rate</th><th>Mode</th><th>Added latency</th></tr>
          </thead>
          <tbody>
            {list.map((b) => (
              <tr key={b.id} className={b.enabled ? "" : "disabled"}>
                <td className="mono"><b>{b.id}</b><div className="small muted">{LOCATION_LABEL[b.location] ?? b.location}</div></td>
                <td>
                  <StatusBadge b={b} />
                  <div className="small muted" style={{ maxWidth: 220 }}>
                    {b.health?.reason}
                    {b.health?.probeLatencyMs != null && ` · probe ${b.health.probeLatencyMs} ms`}
                  </div>
                </td>
                <td>{b.tier}</td>
                <td className="mono small">{b.model}</td>
                <td>${b.priceInPerM} / ${b.priceOutPerM}</td>
                <td>{fmtMs(b.firstTokenTimeoutMs)} / {fmtMs(b.totalTimeoutMs)}</td>
                <td>
                  <span className={`badge ${b.breaker.state === "closed" ? "ok" : b.breaker.state === "open" ? "bad" : "warn"}`}>{b.breaker.state}</span>
                  {b.breaker.state === "open" && <div className="small muted">reopens in {fmtMs(b.breaker.reopensInMs)}</div>}
                  {b.breaker.lastError && <div className="small muted" title={b.breaker.lastError}>{b.breaker.lastError.slice(0, 60)}</div>}
                </td>
                <td>
                  <select value={b.chaos.failRate} disabled={!b.enabled} onChange={(e) => setChaos(b.id, { failRate: Number(e.target.value) })}>
                    {[0, 0.25, 0.5, 1].map((r) => <option key={r} value={r}>{r * 100}%</option>)}
                  </select>
                </td>
                <td>
                  <select value={b.chaos.mode} disabled={!b.enabled} onChange={(e) => setChaos(b.id, { mode: e.target.value })}>
                    {MODES.map((m) => <option key={m}>{m}</option>)}
                  </select>
                </td>
                <td>
                  <select value={b.chaos.addedLatencyMs} disabled={!b.enabled} onChange={(e) => setChaos(b.id, { addedLatencyMs: Number(e.target.value) })}>
                    {[0, 500, 2000, 5000, 10000].map((r) => <option key={r} value={r}>{r} ms</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
