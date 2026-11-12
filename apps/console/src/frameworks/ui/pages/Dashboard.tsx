/**
 * Home, in the Claude Console pattern: a greeting with the two most useful actions, a few
 * headline cards with a trend, the backends as cards, and shortcuts to the main resources.
 */
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, BookOpenText, Brain, Cpu, FlaskConical, KeyRound, MessageSquareText, ShieldCheck, Zap } from "lucide-react";
import { useApp } from "../hooks/appContext";
import { Sparkline, useCountUp } from "../components/charts";
import { statusOf } from "../components/StatusBadge";
import { LOCATION_LABEL } from "../components/StatusBadge";
import type { BackendStatus } from "../../../entities/models";
import { fmtN } from "../../../entities/format";
import { useApi } from "../hooks/api";

const ART: Record<string, { bg: string; Icon: typeof Zap; tags: string[] }> = {
  "groq-fast": { bg: "#8fb3ec", Icon: Zap, tags: ["Default route", "Fastest", "Low cost"] },
  "groq-strong": { bg: "#e5a084", Icon: Brain, tags: ["Escalation", "Ambiguous or long asks"] },
  "local-qwen3.5-4b": { bg: "#ece8dd", Icon: Cpu, tags: ["On-device", "No data leaves"] },
  mock: { bg: "#b9d1c4", Icon: BookOpenText, tags: ["Last resort", "Extractive", "Free"] },
};

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

export function Dashboard({ alerts }: { alerts: number }) {
  const api = useApi();
  const { user, can, go, scope } = useApp();
  const [m, setM] = useState<any | null>(null);
  const [backends, setBackends] = useState<BackendStatus[]>([]);

  useEffect(() => {
    api.metrics({ range: "7d", tenant: scope }).then(setM).catch(() => {});
    api.backends().then(setBackends).catch(() => {});
  }, [scope]);

  const b: any[] = m?.buckets ?? [];
  const last = b.slice(-4).reduce((s, x) => s + x.requests, 0);
  const prev = b.slice(-8, -4).reduce((s, x) => s + x.requests, 0);
  const delta = prev ? (last - prev) / prev : null;
  // 6-hour buckets folded into days for the token bars
  const days = Array.from({ length: 7 }, (_, i) => b.slice(i * 4, i * 4 + 4).reduce((s, x) => s + x.tokens, 0));
  const first = user.name.split(" ")[0];

  return (
    <>
      <div className="page-head" style={{ maxWidth: 960, width: "100%", margin: "8px auto 0" }}>
        <div>
          <h1 className="serif">{greeting()}, {first}</h1>
          <p>{alerts ? `${alerts} thing${alerts === 1 ? "" : "s"} need${alerts === 1 ? "s" : ""} your attention; see the bell.` : "Everything is running normally."}</p>
        </div>
        <div className="actions">
          {can("keys:read") && <button className="btn" onClick={() => go("keys")}><KeyRound size={15} /> Get API key</button>}
          {can("playground:run") && <button className="btn primary" onClick={() => go("playground")}><MessageSquareText size={15} /> Open playground</button>}
        </div>
      </div>

      <div style={{ maxWidth: 960, width: "100%", margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
        <div className="grid c3" data-tour="stats">
          <Kpi k="Requests" sub="last 24 hours" value={last} trend={b.slice(-16).map((x) => x.requests)}
            badge={delta == null ? null : <span className={`delta ${delta >= 0 ? "up" : "down"}`}>{delta >= 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}{Math.abs(Math.round(delta * 100))}%</span>} />
          <Kpi k="Token volume" sub="last 7 days" value={m?.totals.tokens ?? 0} bars={days} />
          <Kpi k="PII masked" sub="requests, last 7 days" value={m?.totals.piiRequests ?? 0}
            badge={<span className="tag pii"><ShieldCheck size={12} /> guardrail on</span>} onClick={can("governance:read") ? () => go("guardrails") : undefined} />
        </div>

        <div className="section-title">
          <h2>Backends</h2>
          {can("backends:read") && <button className="link small" onClick={() => go("backends")}>Health and fault injection</button>}
        </div>
        <div className="grid c4">
          {backends.map((x) => {
            const a = ART[x.id] ?? { bg: "#d9d9d9", Icon: Cpu, tags: [] };
            const st = statusOf(x);
            return (
              <button key={x.id} className="card model-card" onClick={() => can("backends:read") && go("backends")}>
                <div className="model-art" style={{ background: a.bg }}><a.Icon strokeWidth={1.3} /></div>
                <div className="mc-body">
                  <div className="mc-title">
                    {x.id}
                    <span className={`pulse ${st.label === "online" ? "ok" : st.label === "degraded" ? "warn" : "bad"}`} title={st.label} aria-label={st.label} />
                  </div>
                  <div className="tags">
                    {a.tags.map((t) => <span key={t} className="tag">{t}</span>)}
                    {!a.tags.includes(LOCATION_LABEL[x.location]) && <span className="tag">{LOCATION_LABEL[x.location] ?? x.location}</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="section-title"><h2>Resources</h2></div>
        <div className="grid c4">
          <Resource icon={MessageSquareText} title="Playground" body="Send a customer message and watch routing, retrieval and the answer stream in." cta="Open playground" onClick={can("playground:run") ? () => go("playground") : undefined} />
          <Resource icon={KeyRound} title="API keys" body="Scoped, expiring keys with copy-paste examples for cURL, Python and Node." cta="Manage keys" onClick={can("keys:read") ? () => go("keys") : undefined} />
          <Resource icon={ShieldCheck} title="Guardrails" body="PII masking, access control, audit logging and how errors are handled." cta="Review guardrails" onClick={can("governance:read") ? () => go("guardrails") : undefined} />
          <Resource icon={FlaskConical} title="Evaluations" body="Intent accuracy, answer quality, latency and cost across configurations." cta="See results" onClick={can("evals:read") ? () => go("evaluations") : undefined} />
        </div>
        <div className="foot-links">
          {can("backends:read") && <button className="link muted" onClick={() => go("backends")}>API status</button>}
          <a className="link muted" href="https://github.com/fauziridwan1709/nalar-router/blob/main/docs/API.md" target="_blank" rel="noopener noreferrer">API reference</a>
          <a className="link muted" href="https://github.com/fauziridwan1709/nalar-router/blob/main/docs/REPORT.md" target="_blank" rel="noopener noreferrer">Technical report</a>
        </div>
      </div>
    </>
  );
}

function Kpi({ k, sub, value, trend, bars, badge, onClick }: { k: string; sub: string; value: number; trend?: number[]; bars?: number[]; badge?: React.ReactNode; onClick?: () => void }) {
  const v = useCountUp(value);
  const max = Math.max(...(bars ?? [0]), 1);
  return (
    <div className="card stat-card" onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined}>
      <div className="k">{k}<span style={{ marginLeft: "auto" }}>{badge}</span></div>
      <div className="row">
        <div>
          <div className="v num">{value >= 1e5 ? `${(v / 1e6).toFixed(2)}M` : fmtN(Math.round(v))}</div>
          <div className="d">{sub}</div>
        </div>
        {trend && trend.length > 1 && <Sparkline values={trend} />}
        {bars && (
          <svg width={92} height={34} aria-hidden="true">
            {bars.map((x, i) => {
              const h = Math.max(3, (x / max) * 30);
              return <rect key={i} className="anim-grow-y" style={{ animationDelay: `${i * 50}ms` }} x={i * 13} y={34 - h} width={9} height={h} rx={2} fill={i === bars.length - 1 ? "var(--good)" : "var(--line-strong)"} />;
            })}
          </svg>
        )}
      </div>
    </div>
  );
}

function Resource({ icon: I, title, body, cta, onClick }: { icon: typeof Zap; title: string; body: string; cta: string; onClick?: () => void }) {
  return (
    <div className="card res-card">
      <h3><I size={17} /> {title}</h3>
      <p>{body}</p>
      <button className="btn sm" onClick={onClick} disabled={!onClick} title={onClick ? undefined : "Your role doesn't include this"}>{cta}</button>
    </div>
  );
}
