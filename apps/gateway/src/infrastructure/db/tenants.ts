import type { DB } from "./db.js";
import { parsePolicy, type PiiPolicy } from "../../domain/guardrails/pii.js";
import type { Tenant } from "../../domain/types.js";
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
