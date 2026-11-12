/** Dashboard metrics, request logs and the audit trail, scoped and redacted per caller. */
import type { User } from "../entities/auth/user.js";
import { GatewayError } from "../entities/errors.js";
import { isRangeKey, RANGES } from "../entities/reporting.js";
import { isOperator, redactRequest, type Actor } from "./access.js";
import type { GatewayDeps } from "./deps.js";

export function dashboardMetrics(deps: GatewayDeps, range: string, opts: { tenantId?: string; backend?: string }) {
  if (!isRangeKey(range))
    throw new GatewayError(400, "invalid_request", `range must be one of ${Object.keys(RANGES).join(", ")}`);
  if (opts.backend && !deps.backends.some((b) => b.config.id === opts.backend))
    throw new GatewayError(400, "invalid_request", "Unknown backend.");
  return deps.reporting.metrics(range, opts);
}

/** newest first; `user` null means the admin token (nothing redacted) */
export function requestLog(deps: GatewayDeps, user: User | null, opts: { tenantId?: string; limit: number }) {
  const rows = deps.reporting.listRequests({ tenantId: opts.tenantId, limit: Math.min(500, Math.max(1, opts.limit)) });
  return user ? rows.map((r) => redactRequest(user, r)) : rows;
}

/** one request with its attempts; operators reading another tenant's request leave an audit entry */
export function requestDetailFor(deps: GatewayDeps, actor: Actor, id: string) {
  const d = /^req_[a-z0-9]{1,40}$/.test(id) ? deps.reporting.requestDetail(id) : null;
  if (!d || (!isOperator(actor.user) && d.tenant_id !== actor.user.tenantId))
    throw new GatewayError(404, "not_found", "Request not found.");
  if (d.tenant_id !== actor.user.tenantId) {
    deps.audit.record({
      tenantId: d.tenant_id,
      actor: actor.user,
      action: "data.cross_tenant_read",
      target: id,
      ip: actor.ip,
    });
  }
  return redactRequest(actor.user, d);
}

/** for an API key (its own tenant only) or the admin token (any tenant: `tenantId` undefined) */
export function requestDetail(deps: GatewayDeps, id: string, tenantId?: string) {
  const d = deps.reporting.requestDetail(id);
  if (!d || (tenantId !== undefined && d.tenant_id !== tenantId))
    throw new GatewayError(404, "not_found", "Request not found.");
  return d;
}

export const auditTrail = (deps: GatewayDeps, tenantId: string | null) => deps.audit.list(tenantId, 100);
