import { useEffect, useState, type FormEvent } from "react";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck } from "lucide-react";
import { ApiError, demoAccounts, signIn, type DemoAccount, type SessionUser } from "./api";
import { Logo, ROLE_LABEL } from "./ui";

const ROLE_HINT: Record<string, string> = {
  operator: "Every tenant, backends, fault injection",
  owner: "Own tenant, all keys, audit log",
  developer: "Playground, creates and revokes own keys",
  viewer: "Read-only dashboards",
};

export function SignIn({ onSignedIn, notice }: { onSignedIn: (u: SessionUser) => void; notice?: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [demo, setDemo] = useState<DemoAccount[]>([]);

  useEffect(() => {
    demoAccounts().then(setDemo).catch(() => {});
  }, []);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    // client-side checks are for the user's convenience; the server validates everything again
    if (!email.trim() || !password) return setErr("Enter your email address and password.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr("Enter a valid email address.");
    setBusy(true);
    setErr(null);
    try {
      onSignedIn(await signIn(email.trim(), password));
    } catch (e) {
      // the server's messages are deliberately generic; show them as-is, nothing more
      setErr(e instanceof ApiError ? e.message : "Couldn't reach the server. Check your connection and try again.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <div className="signin-art" aria-hidden="true">
        <div className="orb a" />
        <div className="orb b" />
        <div className="signin-quote">
          <Logo size={40} />
          <h2>One gateway for every model your support team relies on.</h2>
          <p>Per-tenant quotas that fail closed, routing with fallback, and metering you can audit, request by request.</p>
          <ul>
            <li><ShieldCheck size={16} /> Role-based access for operators, owners, developers and viewers</li>
            <li><LockKeyhole size={16} /> Scoped, expiring API keys, shown once and stored as digests</li>
          </ul>
        </div>
      </div>
      <main className="signin-form">
        <form onSubmit={submit} noValidate aria-describedby={err ? "signin-error" : undefined}>
          <div className="brand-line">
            <Logo size={30} />
            <b>nalar-router</b>
          </div>
          <h1>Sign in to the console</h1>
          <p className="muted">Use the account your tenant administrator gave you.</p>
          {notice && <div className="banner info small">{notice}</div>}
          <TextInput label="Email" type="email" value={email} onChange={setEmail} placeholder="you@company.com" hasAutoFocus htmlName="email" isRequired />
          <div className="pw">
            <TextInput label="Password" type={show ? "text" : "password"} value={password} onChange={setPassword} htmlName="password" isRequired onEnter={() => submit()} />
            <button type="button" className="icon-btn pw-toggle" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"}>
              {show ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          {err && (
            <div id="signin-error" className="banner error small" role="alert">
              {err}
            </div>
          )}
          <Button type="submit" label={busy ? "Signing in…" : "Sign in"} variant="primary" isLoading={busy} width="100%" endContent={<ArrowRight size={15} />} />
          <p className="tiny muted">Sessions end after 2 hours idle or 12 hours in total. Repeated failed attempts pause sign-in for a while.</p>
        </form>

        {demo.length > 0 && (
          <section className="demo-accounts" aria-label="Demo accounts">
            <div className="demo-head">
              <b>Demo accounts</b>
              <span className="tag warn">demo mode only</span>
            </div>
            <p className="tiny muted">One account per tenant, one per role. Click to fill the form.</p>
            <div className="demo-grid">
              {demo.map((d) => (
                <button
                  key={d.email}
                  type="button"
                  className="demo-card"
                  onClick={() => {
                    setEmail(d.email);
                    if (d.password) setPassword(d.password);
                    setErr(null);
                  }}
                >
                  <span className={`role-dot ${d.role}`} aria-hidden />
                  <span className="demo-meta">
                    <span><b>{ROLE_LABEL[d.role]}</b> · {d.tenant}</span>
                    <span className="mono tiny">{d.email}</span>
                    <span className="tiny muted">{ROLE_HINT[d.role]}</span>
                  </span>
                  {d.password && <span className="mono tiny pw-chip">{d.password}</span>}
                </button>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
