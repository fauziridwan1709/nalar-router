import { useEffect, useState } from "react";
import { Download, ShieldCheck } from "lucide-react";
import { FilterChip, PageHeader } from "../components/kit";
import { useApp } from "../hooks/appContext";
import { Empty } from "../components/ui";
import type { AuditEntry } from "../../../entities/models";
import { useApi } from "../hooks/api";

const LABEL: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in",
  "auth.logout": "Signed out",
  "key.create": "Created API key",
  "key.revoke": "Revoked API key",
  "quota.reset": "Reset quota",
  "chaos.set": "Changed fault injection",
  "chaos.clear": "Cleared fault injection",
  "governance.pii_policy": "Changed PII policy",
  "data.cross_tenant_read": "Operator read tenant data",
};

/** CSV for an auditor; every cell quoted so commas or quotes in a name can't break columns or inject formulas */
function toCsv(rows: AuditEntry[]) {
  const cell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const head = ["time_utc", "event", "actor", "target", "tenant", "details"];
  const lines = rows.map((r) =>
    [new Date(r.at).toISOString(), r.action, r.actorEmail, r.target, r.tenantId, JSON.stringify(r.meta)]
      .map(cell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n");
}

/** a tag colour for an audit action: failed sign-ins and revocations stand out */
function actionTone(action: string) {
  if (action === "auth.login_failed") return "warn";
  if (action === "key.revoke") return "bad";
  if (action.startsWith("governance")) return "pii";
  if (action.startsWith("data.")) return "accent";
  return "";
}

export function AuditLog() {
  const api = useApi();
  const { scope, can } = useApp();
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState("");
  const shown = (rows ?? []).filter((r) => !kind || r.action.startsWith(kind));
  const download = () => {
    const url = URL.createObjectURL(new Blob([toCsv(shown)], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `nalar-audit-${new Date().toISOString().slice(0, 10)}.csv`,
    });
    a.click();
    URL.revokeObjectURL(url);
  };
  useEffect(() => {
    api
      .audit(scope)
      .then(setRows)
      .catch((e) => setErr((e as Error).message));
  }, [scope]);
  return (
    <>
      <PageHeader
        title="Audit log"
        sub="Security-relevant events: sign-ins, keys, policy changes and operator actions."
        actions={
          <button className="btn" onClick={download} disabled={!shown.length}>
            <Download size={15} /> Export CSV
          </button>
        }
      />
      <div className="chips">
        <FilterChip
          label="Event"
          value={kind || "*"}
          onChange={(v) => setKind(v === "*" ? "" : v)}
          options={[
            { value: "*", label: "All" },
            { value: "auth.", label: "Sign-in" },
            { value: "key.", label: "API keys" },
            { value: "governance.", label: "Guardrails" },
            { value: "data.", label: "Data access" },
            { value: "quota.", label: "Quota" },
            { value: "chaos.", label: "Fault injection" },
          ]}
        />
      </div>
      {err && <div className="banner error">{err}</div>}
      <section className="panel">
        <header>
          <div>
            <h2>Recent activity</h2>
            <p>
              The last 100 security-relevant events{can("tenants:all") ? "" : " for your tenant"}. Failed sign-ins for
              unknown accounts are recorded without the email typed.
            </p>
          </div>
        </header>
        <div className="body" style={{ overflow: "auto" }}>
          {rows && shown.length === 0 ? (
            <Empty icon={ShieldCheck} title="No events yet" />
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>Actor</th>
                  <th>Target</th>
                  {can("tenants:all") && <th>Tenant</th>}
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td className="num small">{new Date(r.at).toLocaleString()}</td>
                    <td>
                      <span className={`tag ${actionTone(r.action)}`}>{LABEL[r.action] ?? r.action}</span>
                    </td>
                    <td className="small">{r.actorEmail ?? <span className="muted">unknown</span>}</td>
                    <td className="mono small">{r.target ?? "–"}</td>
                    {can("tenants:all") && <td className="small">{r.tenantId ?? "platform"}</td>}
                    <td className="small muted">
                      {Object.keys(r.meta).length
                        ? Object.entries(r.meta)
                            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
                            .join(" · ")
                        : ""}
                    </td>
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
