/** Public API controller: /healthz and the /v1 routes, authenticated by a tenant API key. */
import type { Express, NextFunction, Request, Response } from "express";
import type { KeyScope } from "../../../entities/auth/apiKey.js";
import { authenticateApiKey } from "../../../use-cases/access.js";
import type { GatewayDeps } from "../../../use-cases/deps.js";
import { requestDetail } from "../../../use-cases/observability.js";
import { backendsForTenant, modelsForTenant } from "../../../use-cases/operations.js";
import { bearer } from "./request.js";
import { chatSpec, supportSpec, type RunCapability } from "./specs.js";

export function mountApi(app: Express, deps: GatewayDeps, runCapability: RunCapability) {
  const tenantAuth = (scope: KeyScope) => (req: Request, _res: Response, next: NextFunction) => {
    const { tenant, key } = authenticateApiKey(deps, bearer(req), scope);
    req.tenant = tenant;
    req.apiKey = key;
    next();
  };

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      backends: deps.backends.map((b) => ({ id: b.config.id, tier: b.config.tier, enabled: b.config.enabled })),
      kbEntries: deps.kb.entries.length,
    });
  });

  app.post("/v1/support/answer", tenantAuth("support.answer"), async (req, res) => {
    await runCapability(req, res, "support.answer", { tenant: req.tenant!, credential: req.apiKey!.id }, supportSpec(deps, res, req.body));
  });

  app.post("/v1/chat/completions", tenantAuth("chat.completions"), async (req, res) => {
    await runCapability(req, res, "chat.completions", { tenant: req.tenant!, credential: req.apiKey!.id }, chatSpec(deps, res, req.body));
  });

  app.get("/v1/models", tenantAuth("chat.completions"), (req, res) => {
    res.json(modelsForTenant(deps, req.tenant!));
  });

  app.get("/v1/backends", tenantAuth("usage.read"), (req, res) => {
    res.json(backendsForTenant(deps, req.tenant!));
  });

  app.get("/v1/usage", tenantAuth("usage.read"), (req, res) => {
    res.json({ tenant: req.tenant!.id, plan: req.tenant!.plan, ...deps.quota.usage(req.tenant!) });
  });

  app.get("/v1/requests/:id", tenantAuth("usage.read"), (req, res) => {
    res.json(requestDetail(deps, String(req.params.id), req.tenant!.id));
  });
}
