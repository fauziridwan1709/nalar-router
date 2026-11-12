/**
 * API keys: create (scoped, expiring), reveal once, revoke; plus a quickstart for calling the
 * inference API and the practices that keep a key safe. The server enforces every rule shown
 * here (scopes, expiry options, the active-key cap, who may revoke what); the form only
 * mirrors them so mistakes are caught before a round trip.
 */
import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { TextInput } from "@astryxdesign/core/TextInput";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { useToast } from "@astryxdesign/core/Toast";
import { CalendarClock, EyeOff, FileLock2, KeyRound, Layers, Plus, RefreshCcw, ShieldAlert, TriangleAlert } from "lucide-react";
import { useApp } from "../hooks/appContext";
import { CopyButton, Empty, Select, timeAgo } from "../components/ui";
import { PageHeader } from "../components/kit";
import { chatSnippet, envSnippet, LANGS, supportSnippet, type Lang } from "../../../entities/snippets";
import type { ApiKey } from "../../../entities/models";
import { ApiError } from "../../../entities/errors";
import { useApi } from "../hooks/api";

const SCOPE_INFO: Record<string, { label: string; desc: string }> = {
  "support.answer": { label: "Support answers", desc: "POST /v1/support/answer: the support assistant" },
  "chat.completions": { label: "Chat completions", desc: "POST /v1/chat/completions: OpenAI-compatible raw chat" },
  "usage.read": { label: "Read usage", desc: "GET /v1/usage, /v1/backends, /v1/requests/:id" },
};
const NAME_RE = /^[\p{L}\p{N} ._()-]+$/u;

export function ApiKeys() {
  const api = useApi();
  const { can, scope, user, tenantName, cfg } = useApp();
  const tenantId = scope || user.tenant!.id;
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const toast = useToast();

  const load = useCallback(
    () =>
      api.keys(scope)
        .then((keys) => {
          setKeys(keys);
          setErr(null);
        })
        .catch((e) => setErr((e as Error).message)),
    [scope],
  );
  useEffect(() => {
    load();
  }, [load]);

  const active = keys?.filter((k) => k.status === "active").length ?? 0;
  const mayRevoke = (k: ApiKey) => k.status === "active" && (can("keys:revoke_any") || (can("keys:revoke_own") && k.createdBy === user.id));

  async function revoke(k: ApiKey) {
    try {
      await api.revokeKey(k.id, scope);
      toast({ body: `Revoked “${k.name}”. Calls with it now fail with 401.`, type: "info" });
      load();
    } catch (e) {
      toast({ body: (e as Error).message, type: "error" });
    } finally {
      setRevoking(null);
    }
  }

  return (
    <>
      <PageHeader title="API keys" sub="Keys your services use to call the gateway. Each key acts as the tenant and spends its quota."
        actions={can("keys:create") ? (
          <button className="btn primary" data-tour="keys-create" onClick={() => setCreating(true)} disabled={active >= cfg.maxActiveKeys}
            title={active >= cfg.maxActiveKeys ? "Revoke a key before creating another" : undefined}>
            <Plus size={15} /> Create key
          </button>
        ) : undefined} />
      {err && <div className="banner error">{err}</div>}
      <section className="panel">
        <header>
          <div>
            <h2>Keys for {tenantName(tenantId)}</h2>
            <p>{active} of {cfg.maxActiveKeys} active keys. A key authenticates as the tenant, and spends its quota.</p>
          </div>
          <div className="tools">
            <button className="icon-btn" onClick={load} aria-label="Refresh"><RefreshCcw size={15} /></button>

          </div>
        </header>
        <div className="body" style={{ overflow: "auto" }}>
          {keys && keys.length === 0 ? (
            <Empty icon={KeyRound} title="No keys yet">Create a key for each service that calls the gateway.</Empty>
          ) : (
            <table className="tbl keys">
              <thead>
                <tr><th>Name</th><th>Key</th><th>Scopes</th><th>Created</th><th>Last used</th><th>Expires</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {(keys ?? []).map((k) => (
                  <tr key={k.id} className={k.status !== "active" ? "disabled" : ""}>
                    <td><b>{k.name}</b><div className="tiny muted">{k.createdByEmail ?? "seeded"}</div></td>
                    <td className="mono small">{k.prefix}…{k.last4}</td>
                    <td><div className="filters tight">{k.scopes.map((s) => <span key={s} className="tag">{s}</span>)}</div></td>
                    <td className="small">{new Date(k.createdAt).toLocaleDateString()}</td>
                    <td className="small">{timeAgo(k.lastUsedAt)}</td>
                    <td className="small">{k.expiresAt ? <ExpiresIn at={k.expiresAt} /> : <span className="tag warn" title="Keys without an expiry are harder to rotate">never</span>}</td>
                    <td><span className={`tag ${k.status === "active" ? "good" : k.status === "revoked" ? "bad" : "warn"}`}>{k.status}</span></td>
                    <td className="r">{mayRevoke(k) && <button className="btn sm danger-ghost" onClick={() => setRevoking(k)}>Revoke</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <div className="grid c32">
        <Quickstart />
        <BestPractices />
      </div>

      {creating && <CreateKey tenantId={tenantId} onClose={() => {
        setCreating(false);
        load();
      }} />}
      <AlertDialog
        isOpen={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke “${revoking?.name ?? ""}”?`}
        description="Every call made with this key fails with 401 from now on. This can't be undone; create a new key to restore access."
        actionLabel="Revoke key"
        actionVariant="destructive"
        onAction={() => revoking && revoke(revoking)}
      />
    </>
  );
}

function ExpiresIn({ at }: { at: number }) {
  const days = Math.ceil((at - Date.now()) / 86_400_000);
  if (days <= 0) return <span className="tag bad">expired</span>;
  return <span className={days <= 7 ? "danger" : ""}>{days <= 1 ? "in 1 day" : `in ${days} days`}</span>;
}

/** what's wrong with a key name, or null; the same rules the API enforces */
function keyNameProblem(name: string): string | null {
  if (!name) return "Give the key a name, such as the service that will use it.";
  if (name.length > 64) return "Use 64 characters or fewer.";
  if (!NAME_RE.test(name)) return "Use letters, numbers, spaces and . _ ( ) - only.";
  return null;
}

function CreateKey({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const api = useApi();
  const { cfg, scope, tenantName } = useApp();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["support.answer"]);
  const [expiry, setExpiry] = useState("90");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [serverErr, setServerErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ key: ApiKey; secret: string } | null>(null);
  const [stored, setStored] = useState(false);

  const trimmed = name.trim();
  const nameErr = keyNameProblem(trimmed);
  const scopeErr = scopes.length === 0 ? "Pick at least one scope." : null;

  async function submit() {
    setTouched(true);
    if (nameErr || scopeErr) return;
    setBusy(true);
    setServerErr(null);
    try {
      const r = await api.createKey(scope, { name: trimmed, scopes, expiresInDays: expiry === "never" ? null : Number(expiry) });
      setCreated(r);
    } catch (e) {
      setServerErr(e instanceof ApiError ? e.message : "Couldn't create the key. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Dialog isOpen onOpenChange={() => stored && onClose()} width={640} purpose="required">
        <DialogHeader title="Save your new key" subtitle={`“${created.key.name}” for ${tenantName(tenantId)}`} />
        <div className="dialog-body">
          <div className="banner warn small"><TriangleAlert size={15} /> This is the only time the full key is shown. We store a one-way digest, so it can't be recovered, only replaced.</div>
          <div className="secret">
            <code className="mono">{created.secret}</code>
            <CopyButton text={created.secret} what="Key copied. Store it in your secret manager." />
          </div>
          <div className="small ink2">Set it as an environment variable where your service runs:</div>
          <CodeBlock code={envSnippet(created.secret)} language="bash" hasCopyButton size="sm" />
          <div className="small muted">Scopes: {created.key.scopes.join(", ")} · {created.key.expiresAt ? `expires ${new Date(created.key.expiresAt).toLocaleDateString()}` : "never expires"}</div>
          <CheckboxInput label="I've copied this key and stored it somewhere safe" value={stored} onChange={setStored} />
          <div className="dialog-actions">
            <button className="btn primary" disabled={!stored} onClick={onClose}>Done</button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} width={560} purpose="form">
      <DialogHeader title="Create API key" subtitle={`For ${tenantName(tenantId)}. Calls with this key spend the tenant's quota.`} onOpenChange={(o) => !o && onClose()} />
      <form className="dialog-body" onSubmit={(e) => {
        e.preventDefault();
        submit();
      }} noValidate>
        <TextInput
          label="Name"
          value={name}
          onChange={setName}
          placeholder="e.g. checkout-service (production)"
          description="Name it after the service and environment, so you know what breaks if you revoke it."
          hasAutoFocus
          status={touched && nameErr ? { type: "error", message: nameErr } : undefined}
        />
        <fieldset className="scopes">
          <legend>Scopes <span className="muted small">grant only what the service calls</span></legend>
          {cfg.keyScopes.map((s) => (
            <CheckboxInput
              key={s}
              label={SCOPE_INFO[s]?.label ?? s}
              description={SCOPE_INFO[s]?.desc}
              value={scopes.includes(s)}
              onChange={(on) => setScopes((cur) => (on ? [...cur, s] : cur.filter((x) => x !== s)))}
            />
          ))}
          {touched && scopeErr && <div className="tiny danger">{scopeErr}</div>}
        </fieldset>
        <Select
          label="Expires"
          hideLabel={false}
          size="md"
          value={expiry}
          onChange={setExpiry}
          options={[
            ...cfg.keyExpiryDays.map((d) => ({ value: String(d), label: `In ${d} days`, description: d === 90 ? "Recommended: rotate quarterly" : undefined })),
            { value: "never", label: "Never", description: "Not recommended: a forgotten key stays valid" },
          ]}
        />
        {serverErr && <div className="banner error small" role="alert">{serverErr}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create key"}</button>
        </div>
      </form>
    </Dialog>
  );
}

function Quickstart() {
  const [lang, setLang] = useState<Lang>("curl");
  const [endpoint, setEndpoint] = useState<"support" | "chat">("support");
  const l = LANGS.find((x) => x.id === lang)!;
  const base = location.origin;
  const code = endpoint === "support" ? supportSnippet(lang, base, { message: "how can I cancel my order 12345?" }) : chatSnippet(lang, base);
  return (
    <section className="panel" data-tour="keys-quickstart">
      <header>
        <div>
          <h2>Quickstart: call the inference API</h2>
          <p>Three steps from a new key to a streamed answer.</p>
        </div>
      </header>
      <div className="body">
        <ol className="steps">
          <li><div><b>Create a key</b> with only the scopes the service needs. Copy it when it's shown.</div></li>
          <li>
            <div><b>Store it as an environment variable</b> on the server that calls us, never in browser or mobile code.</div>
            <CodeBlock code={envSnippet()} language="bash" size="sm" />
          </li>
          <li>
            <div><b>Send a request</b> with <span className="mono">Authorization: Bearer $NALAR_API_KEY</span>.</div>
            <div className="qs-tabs">
              <Select label="Endpoint" width={260} value={endpoint} onChange={(v) => setEndpoint(v as "support" | "chat")} options={[
                { value: "support", label: "Support answer", description: "POST /v1/support/answer · scope support.answer" },
                { value: "chat", label: "Chat completions", description: "POST /v1/chat/completions · scope chat.completions" },
              ]} />
              <TabList value={lang} onChange={(v) => setLang(v as Lang)} size="sm">
                {LANGS.map((x) => <Tab key={x.id} value={x.id} label={x.label} />)}
              </TabList>
            </div>
            <CodeBlock code={code} language={l.language} hasCopyButton maxHeight={340} size="sm" />
          </li>
        </ol>
        <table className="table-view errors">
          <thead><tr><th>Status</th><th>Code</th><th>What to do</th></tr></thead>
          <tbody>
            <tr><td>401</td><td className="mono">invalid_api_key</td><td>The key is wrong, revoked or expired. Use a current key.</td></tr>
            <tr><td>403</td><td className="mono">insufficient_scope</td><td>The key lacks the endpoint's scope. Create one with it.</td></tr>
            <tr><td>429</td><td className="mono">quota_exceeded</td><td>Monthly quota used. Wait for the Retry-After header, or raise the plan.</td></tr>
            <tr><td>400</td><td className="mono">invalid_request</td><td>The body failed validation; the message says which field.</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BestPractices() {
  const items = [
    { I: EyeOff, t: "Keep keys server-side", d: "A key in a browser, app bundle or public repo is a key anyone can use. Call the gateway from your backend." },
    { I: Layers, t: "One key per service and environment", d: "Separate keys for staging and production, and per service, so revoking one doesn't take down the rest." },
    { I: FileLock2, t: "Least privilege", d: "Give each key only the scopes it calls. A reporting job needs usage.read, not chat." },
    { I: CalendarClock, t: "Expire and rotate", d: "Prefer 90 days or less. Rotate by creating the new key, deploying it, then revoking the old one." },
    { I: ShieldAlert, t: "Revoke on any doubt", d: "If a key may have leaked, revoke it now. Keys start with nr_live_ so secret scanners can flag them." },
  ];
  return (
    <section className="panel">
      <header><div><h2>Key safety</h2><p>What we do for you, and what's on your side.</p></div></header>
      <div className="body">
        <ul className="practices">
          {items.map(({ I, t, d }) => (
            <li key={t}>
              <span className="pi"><I size={16} /></span>
              <div><b>{t}</b><p>{d}</p></div>
            </li>
          ))}
        </ul>
        <div className="callout small">
          <KeyRound size={15} />
          <span>The gateway stores only a SHA-256 digest of each key, records its last use, and answers revoked, expired and unknown keys with the same 401.</span>
        </div>
      </div>
    </section>
  );
}
