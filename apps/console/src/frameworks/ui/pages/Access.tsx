/** Access: who can sign in to the tenant (owners and operators), and what each role may do. */
import { Fragment, useEffect, useState } from "react";
import { Check, Minus } from "lucide-react";
import { useApp } from "../hooks/appContext";
import { PageHeader } from "../components/kit";
import { timeAgo } from "../components/ui";
import type { Role, Permission, Member } from "../../../entities/models";
import { hasPermission, ROLES, ROLE_LABEL } from "../../../entities/access";
import { useApi } from "../hooks/api";

/** mirrors apps/gateway/src/auth/rbac.ts; the server is the source of truth and enforces it */
const MATRIX: { group: string; rows: { perm: Permission; label: string }[] }[] = [
  {
    group: "Monitor",
    rows: [
      { perm: "dashboard:read", label: "Dashboards, usage, cost, reliability" },
      { perm: "requests:read", label: "Request logs" },
      { perm: "usage:read", label: "Quotas" },
    ],
  },
  {
    group: "Build",
    rows: [
      { perm: "playground:run", label: "Run the playground (spends quota)" },
      { perm: "keys:read", label: "See API keys" },
      { perm: "keys:create", label: "Create API keys" },
      { perm: "keys:revoke_own", label: "Revoke keys they created" },
      { perm: "keys:revoke_any", label: "Revoke any key in the tenant" },
    ],
  },
  {
    group: "Security & data",
    rows: [
      { perm: "governance:read", label: "See guardrails" },
      { perm: "governance:write", label: "Change the PII policy" },
      { perm: "members:read", label: "See members" },
      { perm: "audit:read", label: "Read the audit log" },
    ],
  },
  {
    group: "Platform",
    rows: [
      { perm: "tenants:all", label: "Act on every tenant" },
      { perm: "quota:reset", label: "Reset quotas" },
      { perm: "chaos:write", label: "Inject backend faults" },
    ],
  },
];

export function Access() {
  const api = useApi();
  const { can, scope, user, tenantName } = useApp();
  const [members, setMembers] = useState<Member[] | null>(null);
  useEffect(() => {
    if (can("members:read"))
      api
        .members(scope)
        .then(setMembers)
        .catch(() => setMembers([]));
  }, [can, scope]);

  return (
    <>
      <PageHeader
        title="Access"
        sub="Who can sign in, and what each role is allowed to do. The gateway enforces this on every request."
      />
      {can("members:read") ? (
        <section className="panel">
          <header>
            <div>
              <h2>Members</h2>
              <p>Accounts are provisioned by an operator. There is no self sign-up.</p>
            </div>
          </header>
          <div className="body" style={{ overflow: "auto" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  {can("tenants:all") && <th>Tenant</th>}
                  <th>Last sign-in</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(members ?? []).map((m) => (
                  <tr key={m.id}>
                    <td>
                      <b>{m.name}</b>
                      {m.id === user.id && (
                        <span className="tag" style={{ marginLeft: 8 }}>
                          you
                        </span>
                      )}
                    </td>
                    <td className="mono small">{m.email}</td>
                    <td>
                      <span className="state">
                        <span className={`role-dot ${m.role}`} />
                        {ROLE_LABEL[m.role]}
                      </span>
                    </td>
                    {can("tenants:all") && <td>{tenantName(m.tenantId)}</td>}
                    <td className="small">{timeAgo(m.lastLoginAt)}</td>
                    <td>
                      <span className={`tag ${m.disabled ? "bad" : "good"}`}>{m.disabled ? "disabled" : "active"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <div className="banner info small">
          Only owners and operators can see the member list. Your role: <b>{ROLE_LABEL[user.role]}</b>.
        </div>
      )}

      <section className="panel">
        <header>
          <div>
            <h2>Roles and permissions</h2>
            <p>The same table the server checks (apps/gateway/src/auth/rbac.ts).</p>
          </div>
        </header>
        <div className="body" style={{ overflow: "auto" }}>
          <table className="table-view matrix">
            <thead>
              <tr>
                <th>Permission</th>
                {ROLES.map((r) => (
                  <th key={r}>
                    <span className="state" style={{ justifyContent: "center" }}>
                      <span className={`role-dot ${r}`} />
                      {ROLE_LABEL[r]}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MATRIX.map((g) => (
                <Fragment key={g.group}>
                  <tr>
                    <td colSpan={5} className="small" style={{ color: "var(--muted)", paddingTop: 14 }}>
                      {g.group}
                    </td>
                  </tr>
                  {g.rows.map((row) => (
                    <tr key={row.perm}>
                      <td>
                        {row.label} <span className="mono tiny muted">{row.perm}</span>
                      </td>
                      {ROLES.map((r) => (
                        <td key={r} aria-label={hasPermission(r, row.perm) ? "allowed" : "not allowed"}>
                          {hasPermission(r, row.perm) ? (
                            <Check size={16} className="yes" />
                          ) : (
                            <Minus size={16} className="no" />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
