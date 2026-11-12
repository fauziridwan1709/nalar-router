/** Tenant-level use cases: quota standing and reset, the PII guardrail policy, and members. */
import { can } from "../entities/auth/rbac.js";
import type { User } from "../entities/auth/user.js";
import { GatewayError } from "../entities/errors.js";
import { PII_LABEL, PII_TYPES, scanPii, type PiiMode, type PiiType } from "../entities/guardrails/pii.js";
import type { Tenant } from "../entities/types.js";
import { findTenant, type Actor } from "./access.js";
import type { GatewayDeps } from "./deps.js";

/** quota standing per tenant: usage this period plus outcome counts */
export function usageReport(deps: GatewayDeps, tenants: Tenant[]) {
  return tenants.map((t) => ({
    tenant: t.id, name: t.name, plan: t.plan, allowedTiers: t.allowedTiers,
    ...deps.quota.usage(t),
    outcomes: deps.reporting.outcomes(t.id),
  }));
}

/**
 * The console's quota view: the usage report plus quota rejections this period, and whether the
 * newest one came after the last admitted request. A tenant can be refused while under 100%,
 * because each request reserves its prompt plus a minimum answer.
 */
export function quotaOverview(deps: GatewayDeps, tenantId: string | null) {
  const tenants = tenantId ? [deps.tenants.get(tenantId)!] : deps.tenants.list();
  return tenants.map((t) => {
    const usage = deps.quota.usage(t);
    const q = deps.reporting.quotaRejections(t.id, usage.periodStart);
    return {
      tenant: t.id, name: t.name, plan: t.plan, allowedTiers: t.allowedTiers, profileFields: Object.keys(t.profile).length,
      ...usage,
      quotaRejections: q.rejected,
      rejecting: q.lastRejectedAt != null && q.lastRejectedAt >= (q.lastAdmittedAt ?? 0),
      outcomes: deps.reporting.outcomes(t.id),
    };
  });
}

/** start a new quota period now; `actor` is null for the admin-token route, which isn't audited */
export function resetTenantQuota(deps: GatewayDeps, tenantId: string, actor: Actor | null, opts: { strictId: boolean } = { strictId: true }) {
  const t = opts.strictId ? findTenant(deps, tenantId) : deps.tenants.get(tenantId);
  if (!t) throw new GatewayError(404, "not_found", "Tenant not found.");
  deps.quota.reset(t.id);
  if (actor) deps.audit.record({ tenantId: t.id, actor: actor.user, action: "quota.reset", target: t.id, ip: actor.ip });
  return deps.quota.usage(deps.tenants.get(t.id)!);
}

const GOVERNANCE_WINDOW_DAYS = 30;

/** the tenant's PII policy and what the guardrail did over the last 30 days */
export function governanceReport(deps: GatewayDeps, user: User, tenantId: string, now = Date.now()) {
  const t = deps.tenants.get(tenantId)!;
  const { requests, withPii } = deps.reporting.piiActivity(tenantId, now - GOVERNANCE_WINDOW_DAYS * 86_400_000);
  const byType: Record<string, number> = {};
  for (const r of withPii) for (const part of r.pii.split(",")) {
    const [k, n] = part.split(":");
    byType[k] = (byType[k] ?? 0) + Number(n || 0);
  }
  return {
    tenant: { id: t.id, name: t.name },
    piiPolicy: t.piiPolicy,
    piiTypes: PII_TYPES.map((id) => ({ id, label: PII_LABEL[id] })),
    stats: {
      windowDays: GOVERNANCE_WINDOW_DAYS,
      requests,
      requestsWithPii: withPii.length,
      blocked: withPii.filter((r) => r.errorCode === "pii_detected").length,
      byType,
    },
    canEdit: can(user.role, "governance:write"),
  };
}

export function updatePiiPolicy(deps: GatewayDeps, actor: Actor, tenantId: string, policy: { mode: PiiMode; types: PiiType[] }) {
  if (policy.mode !== "off" && policy.types.length === 0) {
    throw new GatewayError(400, "invalid_request", "Pick at least one type of personal data, or turn the guardrail off.");
  }
  const before = deps.tenants.get(tenantId)!.piiPolicy;
  deps.tenants.setPiiPolicy(tenantId, { mode: policy.mode, types: [...new Set(policy.types)] });
  deps.audit.record({
    tenantId, actor: actor.user, action: "governance.pii_policy", target: tenantId, ip: actor.ip,
    meta: { from: before.mode, to: policy.mode, types: policy.types },
  });
  return { piiPolicy: deps.tenants.get(tenantId)!.piiPolicy };
}

/** a dry run of the detector with the tenant's policy: nothing is stored or sent to a model */
export function testPiiPolicy(deps: GatewayDeps, tenantId: string, text: string) {
  const s = scanPii(text, deps.tenants.get(tenantId)!.piiPolicy.types);
  return { masked: s.masked, findings: s.findings.map((f) => ({ type: f.type, label: PII_LABEL[f.type], placeholder: `{{${f.slot}}}` })) };
}

export const listMembers = (deps: GatewayDeps, tenantId: string | null) => deps.users.members(tenantId);
