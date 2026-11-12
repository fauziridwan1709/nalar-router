/**
 * Read-side queries over the metering tables, for the dashboard, logs and quota pages. The rows
 * are reporting shapes, not entities: the use cases filter, scope and redact them, nothing more.
 */
import type { RangeKey } from "../../entities/reporting.js";

/** a metered request row (snake_case, as stored) plus its parsed route reason */
export type RequestRow = Record<string, any> & { id: string; tenant_id: string; outcome: string };

export interface Reporting {
  metrics(range: RangeKey, opts: { tenantId?: string; backend?: string }): unknown;
  listRequests(opts: { tenantId?: string; limit: number }): RequestRow[];
  /** one request with its attempts, or null */
  requestDetail(id: string): (RequestRow & { attempts: Record<string, any>[] }) | null;
  /** count of each outcome for a tenant, all time */
  outcomes(tenantId: string): { outcome: string; n: number }[];
  /** quota rejections since `since`, and when the newest rejection and admission happened */
  quotaRejections(tenantId: string, since: number): { rejected: number; lastRejectedAt: number | null; lastAdmittedAt: number | null };
  /** requests since `since`, and the PII summary and error code of those that had PII */
  piiActivity(tenantId: string, since: number): { requests: number; withPii: { pii: string; errorCode: string | null }[] };
}
