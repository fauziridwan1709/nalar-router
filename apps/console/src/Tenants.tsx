import { useCallback, useEffect, useState } from "react";
import { admin, fmtN, fmtUsd, type DemoConfig } from "./api";
import { GROUP, groupOf, type Group } from "./ui";

/** meter: fill carries severity (accent → warning → critical); the track is a lighter step */
function Meter({ used, total, label }: { used: number; total: number; label: string }) {
  const p = total ? Math.min(1, used / total) : 1;
  const cls = p >= 0.9 ? "crit" : p >= 0.7 ? "warn" : "";
  return (
    <div>
      <div className="filters small" style={{ justifyContent: "space-between" }}>
        <span className="ink2">{label}</span>
        <span className="num">
          {fmtN(used)} / {fmtN(total)} <span className="muted">({Math.round(p * 100)}%)</span>
        </span>
      </div>
      <div className={`meter ${cls}`} role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={total} aria-label={label}>
        <div style={{ width: `${p * 100}%` }} />
      </div>
    </div>
  );
}

export function Tenants({ cfg }: { cfg: DemoConfig }) {
  const [usage, setUsage] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(
    () => admin<any[]>(cfg.adminToken, "/admin/usage").then((u) => (setUsage(u), setErr(null))).catch((e) => setErr(String(e))),
    [cfg.adminToken],
  );
  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      {err && <div className="banner error">{err}</div>}
      <p className="muted small" style={{ margin: 0 }}>
        Quotas are monthly (UTC) and fail closed: when a check can't be completed, the request is rejected rather than served unmetered.
      </p>
      <div className="grid c2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))" }}>
        {usage.map((u) => {
          const t = cfg.tenants.find((x) => x.id === u.tenant);
          const outcomes: Record<Group, number> = { success: 0, refused: 0, rejected: 0, failed: 0 };
          for (const o of u.outcomes) outcomes[groupOf(o.outcome)] += o.n;
          const profileN = Object.keys(t?.profile ?? {}).length;
          return (
            <section className="panel" key={u.tenant}>
              <header>
                <div>
                  <h2>{u.name}</h2>
                  <p>
                    <span className="mono">{u.tenant}</span> · {u.plan} plan · tiers {u.allowedTiers.join(", ")}
                  </p>
                </div>
                <div className="tools">
                  <button className="btn sm" onClick={() => admin(cfg.adminToken, `/admin/tenants/${u.tenant}/reset-quota`, { method: "POST" }).then(load)}>
                    Reset quota
                  </button>
                </div>
              </header>
              <div className="body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Meter label="Tokens this month" used={u.tokenQuota - u.tokensRemaining} total={u.tokenQuota} />
                <Meter label="Requests this month" used={u.requestsUsed} total={u.requestQuota} />
                <div className="metrics" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginBottom: 0 }}>
                  <div className="metric"><div className="k">Estimated cost</div><div className="v">{fmtUsd(u.costUsd)}</div></div>
                  <div className="metric"><div className="k">In flight</div><div className="v">{fmtN(u.tokensReserved)} tokens</div><div className="s">reserved, not yet metered</div></div>
                  <div className="metric"><div className="k">Company profile</div><div className="v">{profileN ? `${profileN} fields` : "Not set"}</div><div className="s">{profileN ? "fills answer placeholders" : "answers use generic phrases"}</div></div>
                </div>
                <div className="filters small">
                  {(Object.keys(GROUP) as Group[]).map((g) => (
                    <span className="state" key={g}>
                      <span style={{ color: GROUP[g].color }}>{GROUP[g].icon}</span>
                      {GROUP[g].label} <b className="num">{fmtN(outcomes[g])}</b>
                    </span>
                  ))}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
