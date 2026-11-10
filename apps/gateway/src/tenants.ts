import type { DB } from "./db.js";
import { hashKey } from "./db.js";
import type { Tier } from "./config.js";

export interface Tenant {
  id: string;
  name: string;
  plan: string;
  allowedTiers: Tier[];
  tokenQuota: number;
  requestQuota: number;
  quotaResetAt: number;
  profile: Record<string, string>;
}

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
  };
}

export function findTenantByKey(db: DB, apiKey: string): Tenant | null {
  const r = db.prepare("SELECT * FROM tenants WHERE api_key_hash = ?").get(hashKey(apiKey));
  return r ? rowToTenant(r) : null;
}

export function getTenant(db: DB, id: string): Tenant | null {
  const r = db.prepare("SELECT * FROM tenants WHERE id = ?").get(id);
  return r ? rowToTenant(r) : null;
}

export function listTenants(db: DB): Tenant[] {
  return db.prepare("SELECT * FROM tenants ORDER BY created_at, id").all().map(rowToTenant);
}
