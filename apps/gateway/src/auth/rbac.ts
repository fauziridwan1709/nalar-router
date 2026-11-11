/**
 * Role-based access control for the console. Permissions are checked on the server for
 * every console route; the console only uses the same table to hide what a role can't do.
 *
 * - operator:  platform staff. Every tenant, backends, fault injection, quota resets.
 * - owner:     a tenant's administrator. Own tenant: playground, all API keys, audit log.
 * - developer: builds against the API. Own tenant: playground, creates keys, revokes only keys they created.
 * - viewer:    read-only dashboards for their tenant. No playground (it spends quota), no keys.
 */
export const ROLES = ["operator", "owner", "developer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "dashboard:read",
  "requests:read",
  "usage:read",
  "evals:read",
  "backends:read",
  "playground:run",
  "keys:read",
  "keys:create",
  "keys:revoke_own",
  "keys:revoke_any",
  "audit:read",
  "tenants:all", // see and act on every tenant, not only your own
  "quota:reset",
  "chaos:write",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = ["dashboard:read", "requests:read", "usage:read", "evals:read", "backends:read"];

export const GRANTS: Record<Role, readonly Permission[]> = {
  operator: PERMISSIONS,
  owner: [...READ, "playground:run", "keys:read", "keys:create", "keys:revoke_own", "keys:revoke_any", "audit:read"],
  developer: [...READ, "playground:run", "keys:read", "keys:create", "keys:revoke_own"],
  viewer: READ,
};

export const can = (role: Role, p: Permission) => GRANTS[role].includes(p);
export const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as readonly string[]).includes(r);
