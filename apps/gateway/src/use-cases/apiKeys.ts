/**
 * API key management for the console. The plaintext secret leaves the server once, in the
 * `createApiKey` result. Developers may revoke only keys they created; owners and operators any
 * key of the tenants they can see.
 */
import { MAX_ACTIVE_KEYS_PER_TENANT, type KeyScope } from "../entities/auth/apiKey.js";
import { can } from "../entities/auth/rbac.js";
import { GatewayError } from "../entities/errors.js";
import { isOperator, type Actor } from "./access.js";
import type { GatewayDeps } from "./deps.js";

const KEY_ID = /^key_[a-z0-9_]{1,40}$/;

export function listApiKeys(deps: GatewayDeps, tenantId: string) {
  return { tenant: tenantId, keys: deps.apiKeys.list(tenantId) };
}

export function createApiKey(
  deps: GatewayDeps,
  actor: Actor,
  tenantId: string,
  input: { name: string; scopes: KeyScope[]; expiresInDays: number | null },
) {
  const r = deps.apiKeys.create({ tenantId, ...input, createdBy: actor.user.id });
  if ("error" in r) {
    throw new GatewayError(
      409,
      "key_limit_reached",
      `A tenant can have at most ${MAX_ACTIVE_KEYS_PER_TENANT} active keys. Revoke one first.`,
    );
  }
  deps.audit.record({
    tenantId,
    actor: actor.user,
    action: "key.create",
    target: r.key.id,
    ip: actor.ip,
    meta: { ...input },
  });
  return r;
}

export function revokeApiKey(deps: GatewayDeps, actor: Actor, id: string) {
  const k = KEY_ID.test(id) ? deps.apiKeys.get(id) : null;
  if (!k || (!isOperator(actor.user) && k.tenantId !== actor.user.tenantId))
    throw new GatewayError(404, "not_found", "API key not found.");
  if (!can(actor.user.role, "keys:revoke_any") && k.createdBy !== actor.user.id) {
    throw new GatewayError(403, "forbidden", "You can only revoke keys you created.");
  }
  deps.apiKeys.revoke(id);
  deps.audit.record({
    tenantId: k.tenantId,
    actor: actor.user,
    action: "key.revoke",
    target: id,
    ip: actor.ip,
    meta: { name: k.name },
  });
  return { key: deps.apiKeys.get(id) };
}
