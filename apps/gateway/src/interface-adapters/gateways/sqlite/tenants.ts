import type { DatabaseSync as DB } from "node:sqlite";
import type { TenantRepository } from "../../../use-cases/ports/tenants.js";
import { parsePolicy, type PiiPolicy } from "../../../entities/guardrails/pii.js";
import type { Tenant } from "../../../entities/types.js";
export type { Tenant };

function rowToTenant(r: any): Tenant {
  return {
    id: r.id,
    name: r.name,
    plan: r.plan,
    allowedTiers: JSON.parse(r.allowed_tiers),
    tokenQuota: r.token_quota,
    requestQuota: r.request_quota,
    quotaResetAt: r.quota_reset_at,
    profile: r.profile ? JSON.parse(r.profile) : {},
    piiPolicy: parsePolicy(r.pii_policy),
  };
}

export function getTenant(db: DB, id: string): Tenant | null {
  const r = db.prepare("SELECT * FROM tenants WHERE id = ?").get(id);
  return r ? rowToTenant(r) : null;
}

export function listTenants(db: DB): Tenant[] {
  return db.prepare("SELECT * FROM tenants ORDER BY created_at, id").all().map(rowToTenant);
}

export function setPiiPolicy(db: DB, id: string, policy: PiiPolicy) {
  db.prepare("UPDATE tenants SET pii_policy = ? WHERE id = ?").run(JSON.stringify(policy), id);
}

/** the TenantRepository port on SQLite */
export const sqliteTenantRepository = (db: DB): TenantRepository => ({
  get: (id) => getTenant(db, id),
  list: () => listTenants(db),
  setPiiPolicy: (id, policy) => setPiiPolicy(db, id, policy),
});
