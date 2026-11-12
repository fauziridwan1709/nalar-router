/** The Reporting port on SQLite: read-only queries over `requests` and `attempts`. */
import type { DatabaseSync as DB } from "node:sqlite";
import type { Reporting, RequestRow } from "../../../use-cases/ports/reporting.js";
import { getRequestDetail, listRequests } from "./metering.js";
import { computeMetrics } from "./metrics.js";

export const sqliteReporting = (db: DB): Reporting => ({
  metrics: (range, opts) => computeMetrics(db, range, opts),
  listRequests: (opts) => listRequests(db, opts) as RequestRow[],
  requestDetail: (id) => getRequestDetail(db, id),
  outcomes: (tenantId) =>
    db.prepare("SELECT outcome, COUNT(*) AS n FROM requests WHERE tenant_id = ? GROUP BY outcome").all(tenantId) as {
      outcome: string;
      n: number;
    }[],
  quotaRejections: (tenantId, since) => {
    const q = db
      .prepare(
        `SELECT SUM(error_code = 'quota_exceeded') AS rejected,
                MAX(CASE WHEN error_code = 'quota_exceeded' THEN created_at END) AS lastRejectedAt,
                MAX(CASE WHEN counts_against_quota = 1 THEN created_at END) AS lastAdmittedAt
           FROM requests WHERE tenant_id = ? AND created_at >= ?`,
      )
      .get(tenantId, since) as {
      rejected: number | null;
      lastRejectedAt: number | null;
      lastAdmittedAt: number | null;
    };
    return { rejected: q.rejected ?? 0, lastRejectedAt: q.lastRejectedAt, lastAdmittedAt: q.lastAdmittedAt };
  },
  piiActivity: (tenantId, since) => {
    const rows = db
      .prepare("SELECT pii, error_code FROM requests WHERE tenant_id = ? AND created_at >= ? AND pii IS NOT NULL")
      .all(tenantId, since) as { pii: string; error_code: string | null }[];
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM requests WHERE tenant_id = ? AND created_at >= ?")
      .get(tenantId, since) as { n: number };
    return { requests: n, withPii: rows.map((r) => ({ pii: r.pii, errorCode: r.error_code })) };
  },
});
