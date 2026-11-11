import { useCallback, useEffect, useState } from "react";
import { api, fmtMs, type BackendStatus } from "./api";
import { useApp } from "./context";
import { Select } from "./ui";
import { PageHeader } from "./kit";
import { LOCATION_LABEL, StatusBadge } from "./StatusBadge";
import { BACKEND_COLOR } from "./metricsData";

const MODES: { id: string; label: string }[] = [
  { id: "error", label: "Return 503" },
  { id: "hang", label: "Hang (no first token)" },
  { id: "garbage", label: "Unusable output" },
  { id: "slow_first_token", label: "Slow first token" },
];

export function Backends() {
  const { can } = useApp();
  const operator = can("chaos:write");
  const [list, setList] = useState<BackendStatus[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(
    () => api<BackendStatus[]>("/api/console/backends").then((l) => (setList(l), setErr(null))).catch((e) => setErr((e as Error).message)),
    [],
  );
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);
  const setChaos = (id: string, patch: object) =>
    api(`/api/console/chaos/${encodeURIComponent(id)}`, { method: "PUT", json: patch }).then(refresh).catch((e) => setErr((e as Error).message));
  const anyChaos = list.some((b) => b.chaos && (b.chaos.failRate > 0 || b.chaos.addedLatencyMs > 0));

  return (
    <>
      <PageHeader title="Backends" sub="Model backends the router can choose from: availability, pricing, timeouts, circuit breakers and fault injection." />
      {err && <div className="banner error">{err}</div>}
      <section className="panel">
        <header>
          <div>
            <h2>Backends</h2>
            <p>Availability comes from a probe every 30 s plus the circuit breaker (3 consecutive failures open it for 30 s).{!operator && " Probe details and fault injection are visible to operators."}</p>
          </div>
        </header>
        <div className="body" style={{ overflow: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Backend</th><th>Status</th><th>Model</th><th>Tier</th>
                {operator && <><th className="r">Price in / out per 1M</th><th className="r">Timeouts (first token / total)</th></>}<th>Circuit breaker</th>
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
                  {operator && <><td className="r">${b.priceInPerM} / ${b.priceOutPerM}</td>
                  <td className="r">{fmtMs(b.firstTokenTimeoutMs)} / {fmtMs(b.totalTimeoutMs)}</td></>}
                  <td>
                    <span className={`tag ${b.breaker.state === "closed" ? "good" : b.breaker.state === "open" ? "bad" : "warn"}`}>{b.breaker.state}</span>
                    {b.breaker.state === "open" && b.breaker.reopensInMs != null && <div className="muted small">reopens in {fmtMs(b.breaker.reopensInMs)}</div>}
                    {b.breaker.lastError && <div className="muted small" title={b.breaker.lastError}>{b.breaker.lastError.slice(0, 70)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {operator && <section className="panel">
        <header>
          <div>
            <h2>Fault injection</h2>
            <p>Break a backend on purpose, then send a message from the playground and watch the router fall back.</p>
          </div>
          <div className="tools">
            <button className="btn sm" disabled={!anyChaos} onClick={() => api("/api/console/chaos", { method: "DELETE" }).then(refresh).catch((e) => setErr((e as Error).message))}>
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
                    <Select label={`${b.id} failure rate`} width={170} disabled={!b.enabled} value={String(b.chaos!.failRate)} onChange={(v) => setChaos(b.id, { failRate: Number(v) })}
                      options={[0, 0.25, 0.5, 1].map((r) => ({ value: String(r), label: r === 0 ? "Off" : `${r * 100}% of calls` }))} />
                  </td>
                  <td>
                    <Select label={`${b.id} failure mode`} width={210} disabled={!b.enabled} value={b.chaos!.mode} onChange={(v) => setChaos(b.id, { mode: v })}
                      options={MODES.map((m) => ({ value: m.id, label: m.label }))} />
                  </td>
                  <td>
                    <Select label={`${b.id} added latency`} width={150} disabled={!b.enabled} value={String(b.chaos!.addedLatencyMs)} onChange={(v) => setChaos(b.id, { addedLatencyMs: Number(v) })}
                      options={[0, 500, 2000, 5000, 10000].map((r) => ({ value: String(r), label: r ? `+${fmtMs(r)}` : "None" }))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>}
    </>
  );
}
