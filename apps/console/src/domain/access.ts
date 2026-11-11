/**
 * Who may see what in the console: the role → permission grants (a mirror of the gateway's
 * auth/rbac.ts, for display only; the server enforces access) and the page map.
 */
import type { Permission, Role } from "./models";

export const GRANTS: Record<Role, Permission[] | "all"> = {
  operator: "all",
  owner: ["dashboard:read", "requests:read", "usage:read", "evals:read", "backends:read", "governance:read", "playground:run", "keys:read", "keys:create", "keys:revoke_own", "keys:revoke_any", "audit:read", "governance:write", "members:read"],
  developer: ["dashboard:read", "requests:read", "usage:read", "evals:read", "backends:read", "governance:read", "playground:run", "keys:read", "keys:create", "keys:revoke_own"],
  viewer: ["dashboard:read", "requests:read", "usage:read", "evals:read", "backends:read", "governance:read"],
};
export const ROLES: Role[] = ["operator", "owner", "developer", "viewer"];
export const hasPermission = (r: Role, p: Permission) => GRANTS[r] === "all" || (GRANTS[r] as Permission[]).includes(p);

export const ROLE_LABEL: Record<string, string> = { operator: "Operator", owner: "Owner", developer: "Developer", viewer: "Viewer" };

/** every page, the permission it needs, and where it sits in the sidebar */
export const PAGES = {
  dashboard: { label: "Dashboard", perm: "dashboard:read", section: "" },
  playground: { label: "Playground", perm: "playground:run", section: "Build & configure" },
  keys: { label: "API keys", perm: "keys:read", section: "Build & configure" },
  usage: { label: "Usage", perm: "dashboard:read", section: "Monitor" },
  cost: { label: "Cost", perm: "dashboard:read", section: "Monitor" },
  reliability: { label: "Reliability", perm: "dashboard:read", section: "Monitor" },
  logs: { label: "Logs", perm: "requests:read", section: "Monitor" },
  quotas: { label: "Quotas", perm: "usage:read", section: "Monitor" },
  guardrails: { label: "Guardrails", perm: "governance:read", section: "Security & data" },
  access: { label: "Access", perm: "governance:read", section: "Security & data" },
  audit: { label: "Audit log", perm: "audit:read", section: "Security & data" },
  backends: { label: "Backends", perm: "backends:read", section: "Platform" },
  evaluations: { label: "Evaluations", perm: "evals:read", section: "Platform" },
} as const satisfies Record<string, { label: string; perm: Permission; section: string }>;
export type Page = keyof typeof PAGES;
