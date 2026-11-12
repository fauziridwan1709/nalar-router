import { useEffect, useId, useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, Info, KeyRound, ShieldCheck, ScanEye } from "lucide-react";
import { Logo } from "../components/ui";
import SparkTrail from "../components/SparkTrail";
import type { Role, SessionUser, DemoAccount } from "../../../entities/models";
import { ApiError } from "../../../entities/errors";
import { ROLE_LABEL } from "../../../entities/access";
import { useApi } from "../hooks/api";
import { shortName } from "../../../entities/format";

const ROLE_HINT: Record<string, string> = {
  operator: "Every tenant, backends, faults",
  owner: "Keys, guardrails, audit log",
  developer: "Playground, own keys",
  viewer: "Read-only dashboards",
};

export function SignIn({ onSignedIn, notice }: { onSignedIn: (u: SessionUser) => void; notice?: string | null }) {
  const api = useApi();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [demo, setDemo] = useState<DemoAccount[]>([]);
  const id = useId();

  useEffect(() => {
    api.auth.demoAccounts().then(setDemo).catch(() => {});
  }, []);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    // client-side checks are for the user's convenience; the server validates everything again
    if (!email.trim() || !password) return setErr("Enter your email address and password.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr("Enter a valid email address.");
    setBusy(true);
    setErr(null);
    try {
      onSignedIn(await api.auth.signIn(email.trim(), password));
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
      <section className="signin-art" aria-hidden="true">
        <div className="hero-grid" />
        <SparkTrail tint="#d97757" />
        <div className="logo">
          <Logo size={26} />
          <b>nalar <span style={{ color: "#8f8f8c" }}>console</span></b>
        </div>
        <div className="signin-quote">
          <h2>One gateway for every model your <em>support team</em> relies on.</h2>
          <p>Quotas that fail closed, routing with fallback, and metering you can audit request by request.</p>
          <ul>
            <li><ShieldCheck size={17} /> Role-based access, sessions and an audit trail</li>
            <li><ScanEye size={17} /> Personal data masked before any model sees it</li>
            <li><KeyRound size={17} /> Scoped, expiring API keys, shown once</li>
          </ul>
        </div>
        <span className="tiny muted">Move your cursor across this panel.</span>
      </section>

      <main className="signin-form">
        <form onSubmit={submit} noValidate aria-describedby={err ? `${id}-err` : undefined}>
          <h1>Sign in</h1>
          <p>Use the account your tenant administrator gave you.</p>
          {notice && <div className="banner info small"><Info size={15} /> {notice}</div>}
          <div className="field">
            <label htmlFor={`${id}-email`}>Email</label>
            <div className="input">
              <input id={`${id}-email`} type="email" autoComplete="username" placeholder="you@company.com" value={email} autoFocus
                onChange={(e) => setEmail(e.target.value)} aria-invalid={!!err && !email.trim()} maxLength={254} />
            </div>
          </div>
          <div className="field">
            <label htmlFor={`${id}-pw`}>Password</label>
            <div className="input">
              <input id={`${id}-pw`} type={show ? "text" : "password"} autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)} aria-invalid={!!err && !password} maxLength={256} />
              <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"}>
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          {err && <div id={`${id}-err`} className="banner error small" role="alert">{err}</div>}
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? <span className="spinner" aria-hidden /> : null}
            {busy ? "Signing in…" : "Continue"} {!busy && <ArrowRight size={16} />}
          </button>
          <p className="tiny muted" style={{ margin: 0 }}>Sessions end after 2 hours idle or 12 hours in total. Repeated failed attempts pause sign-in for a while.</p>
        </form>

        {demo.length > 0 && (
          <section className="demo-accounts" aria-label="Demo accounts">
            <div className="demo-head">
              <b>Demo accounts</b>
              <span className="tag warn">demo mode only</span>
            </div>
            <div className="demo-grid">
              {demo.map((d) => (
                <button key={d.email} type="button" className="demo-card"
                  onClick={() => {
                    setEmail(d.email);
                    if (d.password) setPassword(d.password);
                    setErr(null);
                  }}>
                  <span className="who"><span className={`role-dot ${d.role}`} aria-hidden /> {ROLE_LABEL[d.role]} · {shortName(d.tenant)}</span>
                  <span className="mono">{d.email}</span>
                  <span className="tiny muted">{ROLE_HINT[d.role]}</span>
                </button>
              ))}
            </div>
            <p className="tiny muted">Click a card to fill the form. Passwords are listed in the README.</p>
          </section>
        )}
      </main>
    </div>
  );
}
