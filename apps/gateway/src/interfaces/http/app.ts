import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import type { Gateway } from "../../gateway.js";
import { GatewayError } from "../../domain/errors.js";
import { getTenant, listTenants, type Tenant } from "../../infrastructure/db/tenants.js";
import { getUsage, resetQuota } from "../../infrastructure/db/quota.js";
import { getRequestDetail, listRequests } from "../../infrastructure/db/metering.js";
import type { ChaosMode } from "../../infrastructure/backends/chaos.js";
import { computeMetrics, RANGES, type RangeKey } from "../../infrastructure/db/metrics.js";
import { authenticateKey, type ApiKeyRow, type KeyScope } from "../../infrastructure/auth/apiKeys.js";
import type { User } from "../../infrastructure/auth/sessions.js";
import { chatSpec, createCapabilityRunner, supportSpec, zodMessage } from "./specs.js";
import { safeEq, securityHeaders } from "./security.js";
import { mountConsole } from "./console.js";
import { backendsFull, ChaosBody, listEvals } from "./shared.js";

declare module "express-serve-static-core" {
  interface Request {
    tenant?: Tenant;
    apiKey?: ApiKeyRow;
    user?: User;
    csrf?: string;
  }
}

function bearer(req: Request): string | null {
  const h = req.header("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return req.header("x-api-key")?.trim() || null;
}

export function createApp(gw: Gateway) {
  const app = express();
  app.disable("x-powered-by");
  // so req.ip / req.secure are the client's when running behind a proxy (Render)
  const tp = gw.config.auth.trustProxy;
  app.set("trust proxy", /^\d+$/.test(tp) ? Number(tp) : tp === "true" ? true : tp === "false" ? false : tp);
  app.use(securityHeaders(gw.config));
  app.use(express.json({ limit: "64kb" }));

  // ---------- auth ----------
  /**
   * Unknown, revoked and expired keys all get the same 401, so a caller can't probe which keys
   * once existed. A key without the route's scope gets 403: the caller already proved possession.
   */
  const tenantAuth = (scope: KeyScope) => (req: Request, _res: Response, next: NextFunction) => {
    const key = bearer(req);
    if (!key) return next(new GatewayError(401, "missing_api_key", "Provide your tenant API key as 'Authorization: Bearer <key>'."));
    const k = authenticateKey(gw.db, key);
    const t = k && getTenant(gw.db, k.tenantId);
    if (!k || !t) return next(new GatewayError(401, "invalid_api_key", "API key is not recognised."));
    if (!k.scopes.includes(scope)) return next(new GatewayError(403, "insufficient_scope", "This API key is not allowed to call this endpoint."));
    req.tenant = t;
    req.apiKey = k;
    next();
  };
  const adminAuth = (req: Request, _res: Response, next: NextFunction) => {
    const tok = req.header("x-admin-token") ?? bearer(req);
    if (!tok || !safeEq(tok, gw.config.adminToken)) return next(new GatewayError(401, "invalid_admin_token", "Admin token required."));
    next();
  };

  const runCapability = createCapabilityRunner(gw);

  // ---------- public API ----------
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      backends: gw.backends.map((b) => ({ id: b.config.id, tier: b.config.tier, enabled: b.config.enabled })),
      kbEntries: gw.kb.entries.length,
    });
  });

  app.post("/v1/support/answer", tenantAuth("support.answer"), async (req, res) => {
    await runCapability(req, res, "support.answer", { tenant: req.tenant!, credential: req.apiKey!.id }, supportSpec(gw, res, req.body));
  });

  app.post("/v1/chat/completions", tenantAuth("chat.completions"), async (req, res) => {
    await runCapability(req, res, "chat.completions", { tenant: req.tenant!, credential: req.apiKey!.id }, chatSpec(gw, res, req.body));
  });

  // OpenAI's model list: the router aliases first, then the tiers and backends this key's plan may use
  app.get("/v1/models", tenantAuth("chat.completions"), (req, res) => {
    const t = req.tenant!;
    const created = Math.floor(gw.startedAt / 1000);
    const usable = gw.backends.filter((b) => b.config.enabled && t.allowedTiers.includes(b.config.tier));
    const ids = ["auto", ...new Set(usable.map((b) => b.config.tier)), ...usable.map((b) => b.config.id)];
    res.json({ object: "list", data: ids.map((id) => ({ id, object: "model", created, owned_by: "nalar-router" })) });
  });

  // which backends exist, whether they're online, and whether this tenant's plan may use them
  app.get("/v1/backends", tenantAuth("usage.read"), (req, res) => {
    res.json(
      gw.backends.map((b) => ({
        id: b.config.id,
        tier: b.config.tier,
        model: b.config.model,
        location: b.config.location,
        allowedForTenant: req.tenant!.allowedTiers.includes(b.config.tier),
        health: gw.health.get(b.config.id),
        breaker: gw.breaker.snapshot(b.config.id).state,
      })),
    );
  });

  app.get("/v1/usage", tenantAuth("usage.read"), (req, res) => {
    res.json({ tenant: req.tenant!.id, plan: req.tenant!.plan, ...getUsage(gw.db, req.tenant!) });
  });

  app.get("/v1/requests/:id", tenantAuth("usage.read"), (req, res) => {
    const d = getRequestDetail(gw.db, String(req.params.id));
    if (!d || d.tenant_id !== req.tenant!.id) throw new GatewayError(404, "not_found", "Request not found.");
    res.json(d);
  });

  // ---------- console (session auth + RBAC) ----------
  mountConsole(app, gw, runCapability);

  // ---------- admin: operator scripts with the admin token (the console uses sessions instead) ----------
  app.get("/admin/usage", adminAuth, (_req, res) => {
    res.json(
      listTenants(gw.db).map((t) => ({
        tenant: t.id, name: t.name, plan: t.plan, allowedTiers: t.allowedTiers, ...getUsage(gw.db, t),
        outcomes: gw.db
          .prepare("SELECT outcome, COUNT(*) AS n FROM requests WHERE tenant_id = ? GROUP BY outcome")
          .all(t.id),
      })),
    );
  });
  app.get("/admin/metrics", adminAuth, (req, res) => {
    const range = String(req.query.range ?? "24h");
    if (!(range in RANGES)) throw new GatewayError(400, "invalid_request", `range must be one of ${Object.keys(RANGES).join(", ")}`);
    res.json(computeMetrics(gw.db, range as RangeKey, { tenantId: req.query.tenant ? String(req.query.tenant) : undefined }));
  });

  app.get("/admin/requests", adminAuth, (req, res) => {
    res.json(listRequests(gw.db, { tenantId: req.query.tenant ? String(req.query.tenant) : undefined, limit: Number(req.query.limit) || 50 }));
  });
  app.get("/admin/requests/:id", adminAuth, (req, res) => {
    const d = getRequestDetail(gw.db, String(req.params.id));
    if (!d) throw new GatewayError(404, "not_found", "Request not found.");
    res.json(d);
  });
  app.get("/admin/backends", adminAuth, (_req, res) => {
    res.json(backendsFull(gw));
  });
  app.put("/admin/chaos/:backend", adminAuth, (req, res) => {
    const id = String(req.params.backend);
    if (!gw.backends.some((b) => b.config.id === id)) throw new GatewayError(404, "not_found", "Backend not found.");
    const body = ChaosBody.parse(req.body ?? {});
    res.json(gw.chaos.set(id, body as { mode?: ChaosMode }));
  });
  app.delete("/admin/chaos", adminAuth, (_req, res) => {
    gw.chaos.clear();
    gw.breaker.reset();
    res.json({ ok: true });
  });
  app.post("/admin/tenants/:id/reset-quota", adminAuth, (req, res) => {
    const t = getTenant(gw.db, String(req.params.id));
    if (!t) throw new GatewayError(404, "not_found", "Tenant not found.");
    resetQuota(gw.db, t.id);
    res.json(getUsage(gw.db, getTenant(gw.db, t.id)!));
  });
  app.get("/admin/evals", adminAuth, (_req, res) => {
    res.json(listEvals(gw));
  });

  // ---------- console static files ----------
  const webDist = gw.config.consoleDist;
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!v1\/|admin\/|api\/|healthz).*/, (_req, res) => {
      res.setHeader("cache-control", "no-cache");
      res.sendFile(resolve(webDist, "index.html"));
    });
  }

  // ---------- errors ----------
  // Every failure ends here (Express 5 forwards rejected async handlers too) and leaves as the
  // documented shape; see domain/errors.ts and docs/ERRORS.md.
  // Unknown routes don't echo the method or path back.
  app.use((_req: Request, _res: Response, next: NextFunction) => next(new GatewayError(404, "not_found", "Not found.")));
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    let ge: GatewayError;
    if (err instanceof GatewayError) ge = err;
    else if (err instanceof ZodError) ge = new GatewayError(400, "invalid_request", zodMessage(err));
    else if (err?.type === "entity.parse.failed") ge = new GatewayError(400, "invalid_json", "Request body is not valid JSON.");
    else if (err?.type === "entity.too.large") ge = new GatewayError(413, "payload_too_large", "Request body exceeds 64kb.");
    else {
      // log the cause with the request id the client also has; the response says nothing about it
      console.error(`[${res.getHeader("x-request-id") ?? "-"}] unhandled error on ${req.method} ${req.path}`, err);
      ge = new GatewayError(500, "internal_error", "Internal error.");
    }
    if (ge.status >= 500 && ge.code !== "internal_error") {
      console.warn(`[${res.getHeader("x-request-id") ?? "-"}] ${ge.status} ${ge.code} on ${req.method} ${req.path}`);
    }
    if (res.headersSent) {
      // already streaming: end the stream with an error in that stream's own format
      try {
        const body = JSON.stringify(ge.toJSON().error);
        res.write(req.path === "/v1/chat/completions" ? `data: ${JSON.stringify({ error: ge.toJSON().error })}\n\ndata: [DONE]\n\n` : `event: error\ndata: ${body}\n\n`);
        res.end();
      } catch {
        /* the connection is already gone */
      }
      return;
    }
    const resetsAt = ge.details?.resetsAt;
    if (ge.status === 429 && typeof resetsAt === "string") {
      res.setHeader("retry-after", String(Math.max(1, Math.ceil((Date.parse(resetsAt) - Date.now()) / 1000))));
    }
    const retryAfter = ge.details?.retryAfterSeconds;
    if (ge.status === 429 && typeof retryAfter === "number") res.setHeader("retry-after", String(retryAfter));
    // the OpenAI-compatible routes also carry OpenAI's error `type` and `param`, which its SDKs read
    const openai = req.path === "/v1/chat/completions" || req.path === "/v1/models";
    const body = ge.toJSON();
    res.status(ge.status).json(openai ? { error: { ...body.error, type: openaiErrorType(ge.status), param: null } } : body);
  });

  return app;
}


function openaiErrorType(status: number) {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}
