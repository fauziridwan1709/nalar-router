import { useCallback, useEffect, useState } from "react";
import { admin, fmtMs, type BackendStatus, type DemoConfig } from "./api";
import { LOCATION_LABEL, StatusBadge } from "./StatusBadge";
import { BACKEND_COLOR } from "./Overview";

const MODES: { id: string; label: string }[] = [
  { id: "error", label: "Return 503" },
  { id: "hang", label: "Hang (no first token)" },
  { id: "garbage", label: "Unusable output" },
  { id: "slow_first_token", label: "Slow first token" },
];

export function Backends({ cfg }: { cfg: DemoConfig }) {
  const [list, setList] = useState<BackendStatus[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(
    () => admin<BackendStatus[]>(cfg.adminToken, "/admin/backends").then((l) => (setList(l), setErr(null))).catch((e) => setErr(String(e))),
    [cfg.adminToken],
  );
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);
  const setChaos = (id: string, patch: object) =>
    admin(cfg.adminToken, `/admin/chaos/${id}`, { method: "PUT", body: JSON.stringify(patch) }).then(refresh).catch((e) => setErr(String(e)));
  const anyChaos = list.some((b) => b.chaos.failRate > 0 || b.chaos.addedLatencyMs > 0);

  return (
    <>
      {err && <div className="banner error">{err}</div>}
      <section className="panel">
        <header>
          <div>
            <h2>Backends</h2>
            <p>Availability comes from a probe every 30 s plus the circuit breaker (3 consecutive failures open it for 30 s).</p>
          </div>
        </header>
        <div className="body" style={{ overflow: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Backend</th><th>Status</th><th>Model</th><th>Tier</th><th className="r">Price in / out per 1M</th>
                <th className="r">Timeouts (first token / total)</th><th>Circuit breaker</th>
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id} className={b.enabled ? "" : "disabled"}>
                  <td>
                    <span className="state">
                      <i style={{ background: BACKEND_COLOR[b.id]?.color ?? "var(--line-strong)" }} />
                      <b className="mono">{b.id}</b>
                    </span>
                    <div className="muted small">{LOCATION_LABEL[b.location] ?? b.location}</div>
                  </td>
                  <td>
                    <StatusBadge b={b} />
                    <div className="muted small" style={{ maxWidth: 240 }}>
                      {b.health?.reason}
                      {b.health?.probeLatencyMs != null && `, probe ${b.health.probeLatencyMs} ms`}
                    </div>
                  </td>
                  <td className="mono small">{b.model}</td>
                  <td>{b.tier}</td>
                  <td className="r">${b.priceInPerM} / ${b.priceOutPerM}</td>
                  <td className="r">{fmtMs(b.firstTokenTimeoutMs)} / {fmtMs(b.totalTimeoutMs)}</td>
                  <td>
                    <span className={`tag ${b.breaker.state === "closed" ? "good" : b.breaker.state === "open" ? "bad" : "warn"}`}>{b.breaker.state}</span>
                    {b.breaker.state === "open" && <div className="muted small">reopens in {fmtMs(b.breaker.reopensInMs)}</div>}
                    {b.breaker.lastError && <div className="muted small" title={b.breaker.lastError}>{b.breaker.lastError.slice(0, 70)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <header>
          <div>
            <h2>Fault injection</h2>
            <p>Break a backend on purpose, then send a message from the playground and watch the router fall back.</p>
          </div>
          <div className="tools">
            <button className="btn sm" disabled={!anyChaos} onClick={() => admin(cfg.adminToken, "/admin/chaos", { method: "DELETE" }).then(refresh)}>
              Clear all faults and reset breakers
            </button>
          </div>
        </header>
        <div className="body" style={{ overflow: "auto" }}>
          <table className="tbl">
            <thead><tr><th>Backend</th><th>Failure rate</th><th>Failure mode</th><th>Added latency</th></tr></thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id} className={b.enabled ? "" : "disabled"}>
                  <td className="mono">{b.id}</td>
                  <td>
                    <select value={b.chaos.failRate} disabled={!b.enabled} aria-label={`${b.id} failure rate`} onChange={(e) => setChaos(b.id, { failRate: Number(e.target.value) })}>
                      {[0, 0.25, 0.5, 1].map((r) => <option key={r} value={r}>{r === 0 ? "Off" : `${r * 100}% of calls`}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={b.chaos.mode} disabled={!b.enabled} aria-label={`${b.id} failure mode`} onChange={(e) => setChaos(b.id, { mode: e.target.value })}>
                      {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={b.chaos.addedLatencyMs} disabled={!b.enabled} aria-label={`${b.id} added latency`} onChange={(e) => setChaos(b.id, { addedLatencyMs: Number(e.target.value) })}>
                      {[0, 500, 2000, 5000, 10000].map((r) => <option key={r} value={r}>{r ? `+${fmtMs(r)}` : "None"}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
