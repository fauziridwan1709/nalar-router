/**
 * Quotas: where each tenant stands against its monthly limits. Stat cards on top, then one row
 * per tenant with a meter for tokens and requests, a status, and a detail row on click. A user
 * pinned to one tenant sees the same page with their tenant opened.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { useToast } from "@astryxdesign/core/Toast";
import { ChevronRight, CircleAlert, CircleCheck, CircleX, RotateCcw, type LucideIcon } from "lucide-react";
import { api, fmtN, fmtUsd, qs } from "./api";
import { GROUP, groupOf, type Group } from "./ui";
import { useApp } from "./context";
import { PageHeader, StatCard } from "./kit";

interface TenantUsage {
  tenant: string;
  name: string;
  plan: string;
  allowedTiers: string[];
  profileFields: number;
  periodStart: number;
  periodEnd: number;
  tokensUsed: number;
  tokensReserved: number;
  requestsUsed: number;
  tokenQuota: number;
  requestQuota: number;
  tokensRemaining: number;
  requestsRemaining: number;
  costUsd: number;
  /** 429 quota_exceeded responses this period */
  quotaRejections: number;
  /** the newest request this period was refused for quota: new requests are being turned away */
  rejecting: boolean;
  outcomes: { outcome: string; n: number }[];
}

type Level = "ok" | "near" | "out";
const LEVEL: Record<Level, { label: string; Icon: LucideIcon; color: string }> = {
  ok: { label: "Within limits", Icon: CircleCheck, color: "var(--good)" },
  near: { label: "Near a limit", Icon: CircleAlert, color: "var(--warning)" },
  out: { label: "Rejecting requests", Icon: CircleX, color: "var(--critical)" },
};

const share = (used: number, total: number) => (total ? Math.min(1, used / total) : 1);
/** tokens count what's metered plus what's reserved by requests still running, as admission does */
const tokenShare = (u: TenantUsage) => share(u.tokenQuota - u.tokensRemaining, u.tokenQuota);
const levelOf = (u: TenantUsage): Level => {
  const p = Math.max(tokenShare(u), share(u.requestsUsed, u.requestQuota));
  return p >= 1 || u.rejecting ? "out" : p >= 0.8 ? "near" : "ok";
};
const pct = (p: number) => (p > 0 && p < 0.01 ? "<1%" : `${Math.round(p * 100)}%`);
const shortName = (n: string) => n.split(" (")[0];

function Bar({ used, total, label }: { used: number; total: number; label: string }) {
  const p = share(used, total);
  return (
    <div className="q-bar">
      <div className="q-bar-top">
        <span className="num"><b>{fmtN(used)}</b> <span className="muted">of {fmtN(total)}</span></span>
        <span className="num muted">{pct(p)}</span>
      </div>
      <div className={`meter ${p >= 1 ? "crit" : p >= 0.8 ? "warn" : ""}`} role="meter" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={total}>
        <div className="anim-meter" style={{ width: `${Math.max(p * 100, used > 0 ? 1.5 : 0)}%` }} />
      </div>
    </div>
  );
}

function Status({ u }: { u: TenantUsage }) {
  const { label, Icon, color } = LEVEL[levelOf(u)];
  return (
    <div>
      <span className="state"><Icon size={15} color={color} aria-hidden /> {label}</span>
      {u.quotaRejections > 0 && <div className="tiny muted">{fmtN(u.quotaRejections)} refused with 429 this month</div>}
    </div>
  );
}

export function Tenants() {
  const { scope, can } = useApp();
  const toast = useToast();
  const [usage, setUsage] = useState<TenantUsage[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(
    () => api<TenantUsage[]>(`/api/console/usage${qs({ tenant: scope })}`).then((u) => (setUsage(u), setErr(null))).catch((e) => setErr((e as Error).message)),
    [scope],
  );
  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [load]);

  const rows = usage ?? [];
  const single = rows.length === 1;
  const expanded = single ? rows[0]?.tenant : open;
  const period = rows[0] && { start: new Date(rows[0].periodStart), end: new Date(rows[0].periodEnd) };
  const daysLeft = period ? Math.max(0, Math.ceil((period.end.getTime() - Date.now()) / 86_400_000)) : null;
  const fmtDay = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

  const tokensUsed = rows.reduce((n, u) => n + u.tokensUsed, 0);
  const tokenQuota = rows.reduce((n, u) => n + u.tokenQuota, 0);
  const requestsUsed = rows.reduce((n, u) => n + u.requestsUsed, 0);
  const requestQuota = rows.reduce((n, u) => n + u.requestQuota, 0);
  const cost = rows.reduce((n, u) => n + u.costUsd, 0);
  const attention = rows.filter((u) => levelOf(u) !== "ok");

  const reset = (u: TenantUsage) =>
    api(`/api/console/tenants/${encodeURIComponent(u.tenant)}/reset-quota`, { method: "POST" })
      .then(() => (toast({ body: `Quota reset for ${shortName(u.name)}`, type: "info" }), load()))
      .catch((e) => toast({ body: (e as Error).message, type: "error" }));

  return (
    <>
      <PageHeader
        title="Quotas"
        sub="Monthly token and request limits per tenant. Quotas fail closed: if a check can't complete, the request is rejected, not served unmetered."
        actions={period && <span className="period-pill">{fmtDay(period.start)} – {fmtDay(period.end)} UTC · resets in {daysLeft} day{daysLeft === 1 ? "" : "s"}</span>}
      />
      {err && <div className="banner error">{err}</div>}

      <div className="grid c4">
        <StatCard k="Tokens this month" value={usage ? tokensUsed : null} fmt={(v) => fmtN(Math.round(v))} sub={usage ? `of ${fmtN(tokenQuota)} · ${pct(share(tokensUsed, tokenQuota))}` : undefined} />
        <StatCard k="Requests this month" value={usage ? requestsUsed : null} fmt={(v) => fmtN(Math.round(v))} sub={usage ? `of ${fmtN(requestQuota)} · ${pct(share(requestsUsed, requestQuota))}` : undefined} />
        <StatCard k="Estimated spend" value={usage ? cost : null} fmt={(v) => fmtUsd(v)} info="Provider list prices × metered tokens, including failed attempts" />
        {single ? (
          <StatCard k="Resets in" value={daysLeft} fmt={(v) => `${Math.round(v)} day${Math.round(v) === 1 ? "" : "s"}`}
            sub={period ? `${fmtDay(period.end)}, 00:00 UTC` : undefined} />
        ) : (
          <StatCard k="Need attention" value={usage ? attention.length : null} fmt={(v) => fmtN(Math.round(v))}
            sub={usage ? (attention.length ? attention.map((u) => shortName(u.name)).join(", ") : "Every tenant is under 80% and admitting requests") : undefined}
            info="A tenant needs attention at 80% of either limit, or as soon as a request is refused with 429 quota_exceeded" />
        )}
      </div>

      <section className="panel q-panel">
        <header>
          <div>
            <h2>{single ? "Your limits" : "Tenants"}</h2>
            <p>Tokens include requests still running (reserved). {single ? "" : "Select a row for details."}</p>
          </div>
        </header>
        <table className={`tbl q-tbl ${single ? "" : "click"}`}>
          <thead>
            <tr>
              <th style={{ width: "24%" }}>Tenant</th>
              <th style={{ width: "24%" }}>Tokens</th>
              <th style={{ width: "22%" }}>Requests</th>
              <th className="r">Spend</th>
              <th>Status</th>
              {can("quota:reset") && <th className="r"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {!usage && <tr><td colSpan={6} className="muted">Loading…</td></tr>}
            {rows.map((u) => {
              const isOpen = expanded === u.tenant;
              return (
                <Fragment key={u.tenant}>
                  <tr
                    className={isOpen ? "open" : undefined}
                    onClick={single ? undefined : () => setOpen(isOpen ? null : u.tenant)}
                    aria-expanded={single ? undefined : isOpen}
                  >
                    <td>
                      <div className="q-name">
                        {!single && <ChevronRight size={15} className="q-chev" aria-hidden />}
                        <div>
                          <b>{shortName(u.name)}</b>
                          <div className="tiny muted"><span className="mono">{u.tenant}</span> · <span className="plan-pill">{u.plan}</span></div>
                        </div>
                      </div>
                    </td>
                    <td><Bar label={`${shortName(u.name)} tokens this month`} used={u.tokenQuota - u.tokensRemaining} total={u.tokenQuota} /></td>
                    <td><Bar label={`${shortName(u.name)} requests this month`} used={u.requestsUsed} total={u.requestQuota} /></td>
                    <td className="r num">{fmtUsd(u.costUsd)}</td>
                    <td><Status u={u} /></td>
                    {can("quota:reset") && (
                      <td className="r">
                        <button className="btn sm ghost" title="Reset this month's usage (demo helper, audited)"
                          onClick={(e) => (e.stopPropagation(), reset(u))}>
                          <RotateCcw size={13} /> Reset
                        </button>
                      </td>
                    )}
                  </tr>
                  {isOpen && (
                    <tr className="q-detail">
                      <td colSpan={6}><Detail u={u} /></td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Detail({ u }: { u: TenantUsage }) {
  const outcomes: Record<Group, number> = { success: 0, refused: 0, rejected: 0, failed: 0 };
  for (const o of u.outcomes) outcomes[groupOf(o.outcome)] += o.n;
  return (
    <div className="q-detail-grid">
      <dl>
        <dt>Tokens left</dt>
        <dd className="num">{fmtN(u.tokensRemaining)}</dd>
        <dt>Requests left</dt>
        <dd className="num">{fmtN(u.requestsRemaining)}</dd>
        <dt>Admission</dt>
        <dd>
          {u.rejecting
            ? <span>New requests are refused: each needs room for its prompt plus at least a short answer, and {fmtN(u.tokensRemaining)} tokens are left.</span>
            : <span className="muted">Each request reserves its prompt plus its answer budget before any model is called.</span>}
        </dd>
        <dt>In flight</dt>
        <dd className="num">{fmtN(u.tokensReserved)} tokens <span className="muted">reserved, not yet metered</span></dd>
      </dl>
      <dl>
        <dt>Model tiers</dt>
        <dd>{u.allowedTiers.map((t) => <span key={t} className="tag">{t}</span>)}</dd>
        <dt>Company profile</dt>
        <dd>{u.profileFields ? `${u.profileFields} fields fill answer placeholders` : <span className="muted">Not set: answers use generic phrases</span>}</dd>
      </dl>
      <div>
        <div className="tiny muted" style={{ marginBottom: 6 }}>Requests by outcome, all time</div>
        <ul className="q-outcomes">
          {(Object.keys(GROUP) as Group[]).map((g) => {
            const I = GROUP[g].Icon;
            return (
              <li key={g}>
                <span className="state"><I size={14} color={GROUP[g].color} aria-hidden /> {GROUP[g].label}</span>
                <b className="num">{fmtN(outcomes[g])}</b>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
