/** Admin controller: operator scripts with the admin token (the console uses sessions instead). */
import type { Express, NextFunction, Request, Response } from "express";
import { GatewayError } from "../../../entities/errors.js";
import type { GatewayDeps } from "../../../use-cases/deps.js";
import { dashboardMetrics, requestDetail, requestLog } from "../../../use-cases/observability.js";
import { backendStatus, clearFaultInjection, evalRuns, setFaultInjection } from "../../../use-cases/operations.js";
import { resetTenantQuota, usageReport } from "../../../use-cases/tenants.js";
import { bearer } from "./request.js";
import { safeEq } from "./security.js";
import type { HttpSettings } from "./settings.js";
import { ChaosBody } from "./shared.js";
import { parseBody } from "./specs.js";

export function mountAdmin(app: Express, deps: GatewayDeps, cfg: HttpSettings) {
  const adminAuth = (req: Request, _res: Response, next: NextFunction) => {
    const tok = req.header("x-admin-token") ?? bearer(req);
    if (!tok || !safeEq(tok, cfg.adminToken)) return next(new GatewayError(401, "invalid_admin_token", "Admin token required."));
    next();
  };
  const tenantParam = (req: Request) => (req.query.tenant ? String(req.query.tenant) : undefined);

  app.get("/admin/usage", adminAuth, (_req, res) => {
    res.json(usageReport(deps, deps.tenants.list()));
  });
  app.get("/admin/metrics", adminAuth, (req, res) => {
    res.json(dashboardMetrics(deps, String(req.query.range ?? "24h"), { tenantId: tenantParam(req) }));
  });
  app.get("/admin/requests", adminAuth, (req, res) => {
    res.json(requestLog(deps, null, { tenantId: tenantParam(req), limit: Number(req.query.limit) || 50 }));
  });
  app.get("/admin/requests/:id", adminAuth, (req, res) => {
    res.json(requestDetail(deps, String(req.params.id)));
  });
  app.get("/admin/backends", adminAuth, (_req, res) => {
    res.json(backendStatus(deps));
  });
  app.put("/admin/chaos/:backend", adminAuth, (req, res) => {
    const id = String(req.params.backend);
    if (!deps.backends.some((b) => b.config.id === id)) throw new GatewayError(404, "not_found", "Backend not found.");
    res.json(setFaultInjection(deps, null, id, parseBody(ChaosBody, req.body)));
  });
  app.delete("/admin/chaos", adminAuth, (_req, res) => {
    res.json(clearFaultInjection(deps, null));
  });
  app.post("/admin/tenants/:id/reset-quota", adminAuth, (req, res) => {
    res.json(resetTenantQuota(deps, String(req.params.id), null, { strictId: false }));
  });
  app.get("/admin/evals", adminAuth, (_req, res) => {
    res.json(evalRuns(deps));
  });
}
