import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api, qs } from "./api";
import { useApp } from "./context";
import { Empty } from "./ui";

interface Entry {
  id: number;
  at: number;
  tenantId: string | null;
  actorEmail: string | null;
  action: string;
  target: string | null;
  meta: Record<string, unknown>;
}

const LABEL: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in",
  "auth.logout": "Signed out",
  "key.create": "Created API key",
  "key.revoke": "Revoked API key",
  "quota.reset": "Reset quota",
  "chaos.set": "Changed fault injection",
  "chaos.clear": "Cleared fault injection",
};

export function AuditLog() {
  const { scope, can } = useApp();
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<Entry[]>(`/api/console/audit${qs({ tenant: scope })}`).then(setRows).catch((e) => setErr((e as Error).message));
  }, [scope]);
  return (
    <>
      {err && <div className="banner error">{err}</div>}
      <section className="panel">
        <header>
          <div>
            <h2>Recent activity</h2>
            <p>The last 100 security-relevant events{can("tenants:all") ? "" : " for your tenant"}. Failed sign-ins for unknown accounts are recorded without the email typed.</p>
          </div>
        </header>
        <div className="body" style={{ overflow: "auto" }}>
          {rows && rows.length === 0 ? (
            <Empty icon={ShieldCheck} title="No events yet" />
          ) : (
            <table className="tbl">
              <thead><tr><th>When</th><th>Event</th><th>Actor</th><th>Target</th>{can("tenants:all") && <th>Tenant</th>}<th>Details</th></tr></thead>
              <tbody>
                {(rows ?? []).map((r) => (
                  <tr key={r.id}>
                    <td className="num small">{new Date(r.at).toLocaleString()}</td>
                    <td><span className={`tag ${r.action === "auth.login_failed" ? "warn" : r.action === "key.revoke" ? "bad" : ""}`}>{LABEL[r.action] ?? r.action}</span></td>
                    <td className="small">{r.actorEmail ?? <span className="muted">unknown</span>}</td>
                    <td className="mono small">{r.target ?? "–"}</td>
                    {can("tenants:all") && <td className="small">{r.tenantId ?? "platform"}</td>}
                    <td className="small muted">{Object.keys(r.meta).length ? Object.entries(r.meta).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`).join(" · ") : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}
