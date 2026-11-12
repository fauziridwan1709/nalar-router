/**
 * Who may see what. API keys map to a tenant; console users are scoped to their own tenant
 * unless they are operators. Another tenant's object returns the same 404 as a missing one, so
 * ids can't be probed across tenants.
 */
import type { ApiKey, KeyScope } from "../entities/auth/apiKey.js";
import { can } from "../entities/auth/rbac.js";
import type { User } from "../entities/auth/user.js";
import { GatewayError, publicAttemptError } from "../entities/errors.js";
import type { Tenant } from "../entities/types.js";
import type { GatewayDeps } from "./deps.js";

/** a signed-in console user acting from an address (for the audit trail) */
export interface Actor {
  user: User;
  ip?: string;
}

const TENANT_ID = /^[a-z0-9_]{1,64}$/;

export const isOperator = (user: User) => can(user.role, "tenants:all");

/**
 * Unknown, revoked and expired keys all get the same 401, so a caller can't probe which keys
 * once existed. A key without the route's scope gets 403: the caller already proved possession.
 */
export function authenticateApiKey(deps: Pick<GatewayDeps, "apiKeys" | "tenants">, secret: string | null, scope: KeyScope): { tenant: Tenant; key: ApiKey } {
  if (!secret) throw new GatewayError(401, "missing_api_key", "Provide your tenant API key as 'Authorization: Bearer <key>'.");
  const key = deps.apiKeys.authenticate(secret);
  const tenant = key && deps.tenants.get(key.tenantId);
  if (!key || !tenant) throw new GatewayError(401, "invalid_api_key", "API key is not recognised.");
  if (!key.scopes.includes(scope)) throw new GatewayError(403, "insufficient_scope", "This API key is not allowed to call this endpoint.");
  return { tenant, key };
}

/** a tenant by id, or 404 for a malformed or unknown id */
export function findTenant(deps: Pick<GatewayDeps, "tenants">, id: string): Tenant {
  const t = TENANT_ID.test(id) ? deps.tenants.get(id) : null;
  if (!t) throw new GatewayError(404, "not_found", "Tenant not found.");
  return t;
}

/**
 * Which tenant a request is about. Operators may pick any tenant (or all, when `allowAll`);
 * everyone else always gets their own, whatever they asked for.
 */
export function scopeTenant(deps: Pick<GatewayDeps, "tenants">, user: User, asked: string, allowAll: true): string | null;
export function scopeTenant(deps: Pick<GatewayDeps, "tenants">, user: User, asked: string, allowAll: false): string;
export function scopeTenant(deps: Pick<GatewayDeps, "tenants">, user: User, asked: string, allowAll: boolean): string | null {
  if (!isOperator(user)) return user.tenantId;
  if (!asked) return allowAll ? null : user.tenantId;
  return findTenant(deps, asked).id;
}

/** the tenant a playground call runs as: your own, or (operators only) the one you picked */
export function playgroundTenant(deps: Pick<GatewayDeps, "tenants">, user: User, asked: string | undefined): Tenant {
  if (asked && asked !== user.tenantId) {
    if (!isOperator(user)) throw new GatewayError(404, "not_found", "Tenant not found.");
    return findTenant(deps, asked);
  }
  return deps.tenants.get(user.tenantId)!;
}

/** what a tenant user may see of a metered request: provider error text stays with operators */
export function redactRequest<T extends Record<string, any>>(user: User, r: T): T {
  if (isOperator(user)) return r;
  const clientFacing = r.outcome === "rejected" || r.outcome === "quota_exceeded";
  return {
    ...r,
    error_message: clientFacing ? r.error_message : null,
    attempts: Array.isArray(r.attempts) ? r.attempts.map((a: any) => ({ ...a, error: a.error ? publicAttemptError(a.outcome) : null })) : r.attempts,
  };
}
