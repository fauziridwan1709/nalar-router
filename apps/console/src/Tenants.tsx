import { useCallback, useEffect, useState } from "react";
import { useToast } from "@astryxdesign/core/Toast";
import { RotateCcw } from "lucide-react";
import { api, fmtN, fmtUsd, qs } from "./api";
import { GROUP, groupOf, type Group } from "./ui";
import { useApp } from "./context";
import { PageHeader } from "./kit";

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
        <div className="anim-meter" style={{ width: `${p * 100}%` }} />
      </div>
    </div>
  );
}

export function Tenants() {
  const { scope, can } = useApp();
  const toast = useToast();
  const [usage, setUsage] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(
    () => api<any[]>(`/api/console/usage${qs({ tenant: scope })}`).then((u) => (setUsage(u), setErr(null))).catch((e) => setErr((e as Error).message)),
    [scope],
  );
  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <PageHeader title="Quotas" sub="Monthly token and request limits per tenant (UTC). Quotas fail closed: if a check can't complete, the request is rejected rather than served unmetered." />
      {err && <div className="banner error">{err}</div>}
      <div className="grid c2">
        {usage.map((u) => {
          const outcomes: Record<Group, number> = { success: 0, refused: 0, rejected: 0, failed: 0 };
          for (const o of u.outcomes) outcomes[groupOf(o.outcome)] += o.n;
          const profileN = u.profileFields ?? 0;
          return (
            <section className="panel" key={u.tenant}>
              <header>
                <div>
                  <h2>{u.name}</h2>
                  <p>
                    <span className="mono">{u.tenant}</span> · {u.plan} plan · tiers {u.allowedTiers.join(", ")}
                  </p>
                </div>
                {can("quota:reset") && (
                  <div className="tools">
                    <button className="btn sm" onClick={() =>
                      api(`/api/console/tenants/${encodeURIComponent(u.tenant)}/reset-quota`, { method: "POST" })
                        .then(() => (toast({ body: `Quota reset for ${u.name}`, type: "info" }), load()))
                        .catch((e) => toast({ body: (e as Error).message, type: "error" }))
                    }>
                      <RotateCcw size={13} /> Reset quota
                    </button>
                  </div>
                )}
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
                      {(() => { const I = GROUP[g].Icon; return <I size={14} color={GROUP[g].color} aria-hidden />; })()}
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
