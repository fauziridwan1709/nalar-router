/**
 * Guardrails: the PII policy for the tenant (mask, block or off, and which kinds of data), a
 * dry-run tester for the detector, and the other built-in controls with where each is enforced.
 * Changing the policy needs governance:write and lands in the audit log.
 */
import { useEffect, useState } from "react";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { useToast } from "@astryxdesign/core/Toast";
import { AlertOctagon, Ban, FileWarning, Fingerprint, Gauge, KeyRound, Lock, ScanEye, ScrollText, ShieldCheck, Users, Wand2 } from "lucide-react";
import { useApp } from "../hooks/appContext";
import { PageHeader, StatCard } from "../components/kit";
import type { Governance } from "../../../entities/models";
import { fmtN, humanize, shortName } from "../../../entities/format";
import { useApi } from "../hooks/api";


const MODE_HELP: Record<string, string> = {
  mask: "Personal data is replaced with placeholders before retrieval and the model. The gateway restores the customer's own email or phone in the answer; card, ID and bank numbers come back only as “ending in 1234”.",
  block: "Requests that contain personal data are rejected with 422 pii_detected before any model is called. They don't count against quota.",
  off: "No scanning. Messages go to the model as written. Use only where the provider has a data processing agreement that covers it.",
};

const SAMPLE = "Hi, I'm Ana. Please cancel order 48213 and refund my card 4111 1111 1111 1111. Email me at ana@example.com or call +62 812 3456 7890. My NIK is 3171234567890123.";

export function Guardrails() {
  const api = useApi();
  const { scope, go, can } = useApp();
  const toast = useToast();
  const [g, setG] = useState<Governance | null>(null);
  const [draft, setDraft] = useState<Governance["piiPolicy"] | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState(SAMPLE);
  const [test, setTest] = useState<{ masked: string; findings: { type: string; label: string; placeholder: string }[] } | null>(null);

  const load = () =>
    api.governance(scope)
      .then((governance) => {
        setG(governance);
        setDraft(governance.piiPolicy);
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
    // reload when the tenant in scope changes; `load` itself is rebuilt every render
  }, [scope]);

  // the tester re-runs as you type (debounced); it never stores or forwards the text
  useEffect(() => {
    const t = setTimeout(() => {
      api.testPii(scope, text.slice(0, 2000)).then(setTest).catch(() => setTest(null));
    }, 250);
    return () => clearTimeout(t);
  }, [text, scope, g?.piiPolicy]);

  const dirty = !!g && !!draft && (draft.mode !== g.piiPolicy.mode || draft.types.slice().sort().join() !== g.piiPolicy.types.slice().sort().join());
  const invalid = !!draft && draft.mode !== "off" && draft.types.length === 0;

  async function save() {
    if (!draft || invalid) return;
    setSaving(true);
    try {
      await api.setPiiPolicy(scope, draft);
      toast({ body: `PII policy for ${shortName(g!.tenant.name)} is now “${draft.mode}”. Recorded in the audit log.`, type: "info" });
      await load();
    } catch (e) {
      toast({ body: (e as Error).message, type: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="Guardrails" sub={<>Governance and security controls built into the gateway{g ? <> for <b>{shortName(g.tenant.name)}</b></> : null}.</>}
        actions={can("audit:read") ? <button className="btn" onClick={() => go("audit")}><ScrollText size={15} /> Audit log</button> : undefined} />
      {err && <div className="banner error">{err}</div>}

      {g && draft && (
        <>
          <div className="grid c3">
            <StatCard k="Requests scanned" value={g.stats.requests} fmt={(v) => fmtN(Math.round(v))} sub={`last ${g.stats.windowDays} days`} />
            <StatCard k="Requests with personal data" value={g.stats.requestsWithPii} fmt={(v) => fmtN(Math.round(v))}
              sub={Object.keys(g.stats.byType).length ? Object.entries(g.stats.byType).map(([t, n]) => `${n} ${humanize(t)}`).join(" · ") : "none found"} />
            <StatCard k="Blocked by policy" value={g.stats.blocked} fmt={(v) => fmtN(Math.round(v))} sub="rejected before a model call" />
          </div>

          <div className="grid c32">
            <section className="panel" data-tour="pii-policy">
              <header>
                <div>
                  <h2>PII masking policy</h2>
                  <p>Applies to every request from this tenant, on both endpoints and the playground.</p>
                </div>
                {!g.canEdit && <div className="tools"><span className="tag"><Lock size={12} /> read only</span></div>}
              </header>
              <div className="body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <SegmentedControl label="Policy" value={draft.mode} onChange={(v) => setDraft({ ...draft, mode: v as typeof draft.mode })} isDisabled={!g.canEdit}
                  disabledMessage="Owners and operators can change the policy">
                  <SegmentedControlItem value="mask" label="Mask" />
                  <SegmentedControlItem value="block" label="Block" />
                  <SegmentedControlItem value="off" label="Off" />
                </SegmentedControl>
                <div className={`banner ${draft.mode === "off" ? "warn" : "info"} small`}>
                  {draft.mode === "off" ? <AlertOctagon size={15} /> : draft.mode === "block" ? <Ban size={15} /> : <ScanEye size={15} />}
                  <span>{MODE_HELP[draft.mode]}</span>
                </div>
                <div>
                  <div className="small ink2" style={{ marginBottom: 8 }}>Detect</div>
                  <div className="grid c2" style={{ gap: 10 }}>
                    {g.piiTypes.map((t) => (
                      <CheckboxInput key={t.id} label={t.label} value={draft.types.includes(t.id)} isDisabled={!g.canEdit || draft.mode === "off"}
                        onChange={(on) => setDraft({ ...draft, types: on ? [...draft.types, t.id] : draft.types.filter((x) => x !== t.id) })} />
                    ))}
                  </div>
                  {invalid && <div className="tiny danger" style={{ marginTop: 6 }}>Pick at least one type, or turn the guardrail off.</div>}
                </div>
                {g.canEdit && (
                  <div className="dialog-actions" style={{ justifyContent: "flex-start" }}>
                    <button className="btn primary" disabled={!dirty || invalid || saving} onClick={save}>{saving ? "Saving…" : "Save policy"}</button>
                    {dirty && <button className="btn ghost" onClick={() => setDraft(g.piiPolicy)}>Discard</button>}
                  </div>
                )}
              </div>
            </section>

            <section className="panel">
              <header><div><h2>Try the detector</h2><p>A dry run with this tenant's types. Nothing is stored or sent to a model.</p></div></header>
              <div className="body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <textarea className="plain" rows={5} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} aria-label="Text to scan" />
                <div className="small ink2">What the model would see</div>
                <div className="masked-preview" aria-live="polite">
                  {test ? test.masked.split(/(\{\{[^}]+\}\})/g).map((part, i) => (part.startsWith("{{") ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>)) : "…"}
                </div>
                <div className="tags">
                  {test?.findings.length ? test.findings.map((f) => <span key={f.placeholder} className="tag pii"><Fingerprint size={12} /> {f.label}</span>) : <span className="tiny muted">No personal data found.</span>}
                </div>
              </div>
            </section>
          </div>

          <section className="panel">
            <header><div><h2>Built-in controls</h2><p>Always on. Where each one is enforced, so it can be reviewed.</p></div></header>
            <div className="body">
              <ul className="guard-list">
                <Control icon={Users} title="Access control" body="Four roles (operator, owner, developer, viewer). Every console route checks a permission on the server; non-operators only ever see their own tenant, and another tenant's id returns 404." where="auth/rbac.ts" go={can("governance:read") ? () => go("access") : undefined} />
                <Control icon={ScrollText} title="Audit logging" body="Sign-ins and failed attempts, key creation and revocation, policy changes, quota resets, fault injection, and operators reading another tenant's data." where="auth/sessions.ts" go={can("audit:read") ? () => go("audit") : undefined} />
                <Control icon={KeyRound} title="Credentials" body="Scoped, expiring API keys stored as digests and shown once; HttpOnly session cookies with CSRF tokens; sign-in rate limits; scrypt password hashing." where="auth/" go={can("keys:read") ? () => go("keys") : undefined} />
                <Control icon={FileWarning} title="Error handling" body="One error shape everywhere. Messages say what to fix, never why internally: the same 401 for any bad key, no permission names in 403, no upstream error text, no echoed paths." where="http/app.ts" />
                <Control icon={Wand2} title="Output safety" body="The model writes {{placeholders}} and the gateway fills them, so it can't invent phone numbers or URLs. The intent header is validated before any text streams; low confidence hands off instead of guessing." where="support/" />
                <Control icon={Gauge} title="Quota fails closed" body="If a quota check can't complete, the request is rejected (503) and no model is called. Usage always comes from the metered requests table." where="quota.ts" go={can("usage:read") ? () => go("quotas") : undefined} />
                <Control icon={ShieldCheck} title="Transport and browser" body="Strict Content-Security-Policy, no framing, no referrer, HSTS over HTTPS, and no caching of any API response." where="http/security.ts" />
              </ul>
            </div>
          </section>
        </>
      )}
    </>
  );
}

function Control({ icon: I, title, body, where, go }: { icon: typeof Lock; title: string; body: string; where: string; go?: () => void }) {
  return (
    <li>
      <span className="gi"><I size={16} /></span>
      <div>
        <b>{title}</b> <span className="tag good" style={{ marginLeft: 6 }}>on</span>
        <p>{body}</p>
        <span className="mono tiny muted">apps/gateway/src/{where}</span>
      </div>
      {go ? <button className="btn sm" onClick={go}>Open</button> : <span />}
    </li>
  );
}
