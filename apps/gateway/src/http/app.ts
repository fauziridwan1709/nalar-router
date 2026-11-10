import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import type { Gateway } from "../gateway.js";
import { GatewayError } from "../errors.js";
import { findTenantByKey, getTenant, listTenants, type Tenant } from "../tenants.js";
import { admit, getUsage, resetQuota } from "../quota.js";
import { finishRequest, getRequestDetail, listRequests, recordRejected } from "../metering.js";
import { prepareSupport, runSupport, type RunResult } from "../support/assistant.js";
import { prepareChat, runChat } from "../chat.js";
import { CollectSink, SseSink, type EventSink } from "./sink.js";
import { ChatSseSink, chatCompletionJson } from "./chatFormat.js";
import { DEMO_TENANTS } from "../db.js";
import type { ChaosMode } from "../backends/chaos.js";
import { computeMetrics, RANGES, type RangeKey } from "../metrics.js";

declare module "express-serve-static-core" {
  interface Request {
    tenant?: Tenant;
  }
}

const SupportBody = z
  .object({
    message: z.string().trim().min(1, "message must not be empty").max(2000, "message too long (max 2000 chars)"),
    model: z.string().max(64).optional(),
    prompt_version: z.enum(["v1", "v2", "v3"]).optional(),
    placeholders: z.enum(["fill", "raw"]).optional(),
    stream: z.boolean().optional(),
    include_reasoning: z.boolean().optional(),
  })
  .strict();

const ChatBody = z
  .object({
    messages: z
      .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().max(16_000) }).strict())
      .min(1)
      .max(50)
      .refine((m) => m.some((x) => x.role === "user" && x.content.trim()), "at least one non-empty user message is required")
      .refine((m) => m.reduce((n, x) => n + x.content.length, 0) <= 32_000, "conversation too long (max 32k chars)"),
    model: z.string().max(64).optional(),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().min(1).max(4096).optional(),
    temperature: z.number().min(0).max(2).optional(),
    include_reasoning: z.boolean().optional(),
  })
  .strict();

function zodMessage(e: ZodError) {
  return e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function bearer(req: Request): string | null {
  const h = req.header("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return req.header("x-api-key")?.trim() || null;
}

export function createApp(gw: Gateway) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  // ---------- auth ----------
  const tenantAuth = (req: Request, _res: Response, next: NextFunction) => {
    const key = bearer(req);
    if (!key) return next(new GatewayError(401, "missing_api_key", "Provide your tenant API key as 'Authorization: Bearer <key>'."));
    const t = findTenantByKey(gw.db, key);
    if (!t) return next(new GatewayError(401, "invalid_api_key", "API key is not recognised."));
    req.tenant = t;
    next();
  };
  const adminAuth = (req: Request, _res: Response, next: NextFunction) => {
    const tok = req.header("x-admin-token") ?? bearer(req);
    if (!tok || !safeEq(tok, gw.config.adminToken)) return next(new GatewayError(401, "invalid_admin_token", "Admin token required."));
    next();
  };

  // ---------- shared capability handler ----------
  async function runCapability(
    req: Request,
    res: Response,
    endpoint: string,
    build: (tenant: Tenant) => {
      estimatedPromptTokens: number;
      requestedMaxTokens: number;
      promptVersion?: string;
      stream: boolean;
      makeSink: () => EventSink;
      run: (ctx: { maxCompletionTokens: number; sink: EventSink; clientSignal: AbortSignal; startedAt: number }) => Promise<RunResult>;
      respondJson: (sink: CollectSink, done: any) => unknown;
    },
  ) {
    const tenant = req.tenant!;
    const requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    res.setHeader("x-request-id", requestId);

    let spec: ReturnType<typeof build>;
    try {
      spec = build(tenant);
    } catch (e) {
      const ge =
        e instanceof ZodError
          ? new GatewayError(400, "invalid_request", zodMessage(e))
          : e instanceof GatewayError
            ? e
            : new GatewayError(500, "internal_error", "Failed to prepare request.");
      try {
        recordRejected(gw.db, requestId, tenant.id, endpoint, ge.status, ge.code, ge.message);
      } catch {
        /* metering failure must not mask the client error */
      }
      throw ge;
    }

    // quota pre-authorisation (throws 429 / 503, fail-closed)
    const admission = admit(gw.db, tenant, {
      requestId,
      endpoint,
      estimatedPromptTokens: spec.estimatedPromptTokens,
      requestedMaxTokens: spec.requestedMaxTokens,
      promptVersion: spec.promptVersion,
    });

    const startedAt = Date.now();
    const client = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) client.abort();
    });

    const sink = spec.stream ? spec.makeSink() : new CollectSink();
    sink.emit("meta", {
      requestId,
      tenant: tenant.id,
      endpoint,
      admission: {
        maxCompletionTokens: admission.maxCompletionTokens,
        tokensRemaining: admission.usage.tokensRemaining,
        requestsRemaining: admission.usage.requestsRemaining,
      },
    });

    let result: RunResult;
    try {
      result = await spec.run({ maxCompletionTokens: admission.maxCompletionTokens, sink, clientSignal: client.signal, startedAt });
    } catch (e) {
      console.error(`[${requestId}] unhandled`, e);
      result = {
        outcome: "internal_error", httpStatus: 500, attempts: [], latencyMs: Date.now() - startedAt,
        errorCode: "internal_error", errorMessage: String((e as Error)?.message ?? e),
      };
      sink.emit("error", { code: "internal_error", message: "Internal error." });
    }

    let summary;
    try {
      summary = finishRequest(gw.db, requestId, result, result.attempts);
    } catch (e) {
      console.error(`[${requestId}] metering write failed`, e);
    }
    const usageAfter = getUsage(gw.db, tenant);
    const done = {
      requestId,
      outcome: result.outcome,
      backend: result.backend ?? null,
      model: result.model ?? null,
      fallbackUsed: summary?.fallbackUsed ?? result.attempts.length > 1,
      attempts: result.attempts.length,
      usage: summary
        ? { promptTokens: summary.promptTokens, completionTokens: summary.completionTokens, totalTokens: summary.totalTokens, source: summary.usageSource }
        : null,
      costUsd: summary?.costUsd ?? null,
      latencyMs: result.latencyMs,
      ttftMs: result.ttftMs ?? null,
      intent: result.intent ?? null,
      confidence: result.confidence ?? null,
      quota: { tokensRemaining: usageAfter.tokensRemaining, requestsRemaining: usageAfter.requestsRemaining },
    };
    sink.emit("done", done);

    if (spec.stream) (sink as SseSink | ChatSseSink).end();
    else if (!res.headersSent) {
      res.status(result.httpStatus === 499 ? 200 : result.httpStatus).json(spec.respondJson(sink as CollectSink, done));
    }
  }

  // ---------- public API ----------
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      backends: gw.backends.map((b) => ({ id: b.config.id, tier: b.config.tier, enabled: b.config.enabled })),
      kbEntries: gw.kb.entries.length,
    });
  });

  app.post("/v1/support/answer", tenantAuth, async (req, res) => {
    await runCapability(req, res, "support.answer", (tenant) => {
      const body = SupportBody.parse(req.body ?? {});
      const promptVersion = body.prompt_version ?? gw.config.support.defaultPromptVersion;
      const prepared = prepareSupport(gw, tenant, {
        message: body.message,
        model: body.model,
        promptVersion,
        includeReasoning: body.include_reasoning,
        placeholders: body.placeholders,
      });
      return {
        estimatedPromptTokens: prepared.estimatedPromptTokens,
        requestedMaxTokens:
          gw.config.support.maxAnswerTokens + (body.include_reasoning ? gw.config.support.reasoningExtraTokens : 0),
        promptVersion,
        stream: body.stream ?? true,
        makeSink: () => new SseSink(res),
        run: (ctx) => runSupport(gw, prepared, ctx),
        respondJson: (s, done) => ({
          ...done,
          attempts: s.all("attempt").filter((a: any) => a.status !== "started"),
          answer: s.last("refusal")?.message ?? s.answer,
          refused: !!s.last("refusal"),
          refusal: s.last("refusal") ?? null,
          intentDetail: s.last("intent") ?? null,
          retrieved: s.last("retrieval"),
          route: s.last("route"),
          error: s.last("error") ?? null,
          steps: s.all("step"),
          reasoning: body.include_reasoning ? s.reasoning : undefined,
        }),
      };
    });
  });

  app.post("/v1/chat/completions", tenantAuth, async (req, res) => {
    await runCapability(req, res, "chat.completions", (tenant) => {
      const body = ChatBody.parse(req.body ?? {});
      const { plan, estimatedPromptTokens } = prepareChat(gw, tenant, body.messages, body.model);
      return {
        estimatedPromptTokens,
        requestedMaxTokens: body.max_tokens ?? 1024,
        stream: body.stream ?? true,
        makeSink: () => new ChatSseSink(res),
        run: (ctx) =>
          runChat(gw, plan, body.messages, { ...ctx, temperature: body.temperature, includeReasoning: body.include_reasoning }),
        respondJson: (s, done) => chatCompletionJson(s, done),
      };
    });
  });

  // which backends exist, whether they're online, and whether this tenant's plan may use them
  app.get("/v1/backends", tenantAuth, (req, res) => {
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

  app.get("/v1/usage", tenantAuth, (req, res) => {
    res.json({ tenant: req.tenant!.id, plan: req.tenant!.plan, ...getUsage(gw.db, req.tenant!) });
  });

  app.get("/v1/requests/:id", tenantAuth, (req, res) => {
    const d = getRequestDetail(gw.db, String(req.params.id));
    if (!d || d.tenant_id !== req.tenant!.id) throw new GatewayError(404, "not_found", "Request not found.");
    res.json(d);
  });

  // ---------- admin / console ----------
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
    res.json(
      gw.backends.map((b) => ({
        id: b.config.id, tier: b.config.tier, model: b.config.model, enabled: b.config.enabled,
        location: b.config.location, health: gw.health.get(b.config.id),
        priceInPerM: b.config.priceInPerM, priceOutPerM: b.config.priceOutPerM,
        firstTokenTimeoutMs: b.config.firstTokenTimeoutMs, totalTimeoutMs: b.config.totalTimeoutMs,
        breaker: gw.breaker.snapshot(b.config.id), chaos: gw.chaos.get(b.config.id),
      })),
    );
  });
  const ChaosBody = z.object({
    failRate: z.number().min(0).max(1).optional(),
    mode: z.enum(["error", "hang", "garbage", "slow_first_token"]).optional(),
    addedLatencyMs: z.number().int().min(0).max(120_000).optional(),
  });
  app.put("/admin/chaos/:backend", adminAuth, (req, res) => {
    const id = String(req.params.backend);
    if (!gw.backends.some((b) => b.config.id === id)) throw new GatewayError(404, "not_found", `Unknown backend ${id}`);
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

  // Demo convenience: lets the hosted console work without copy-pasting keys.
  app.get("/api/demo-config", (_req, res) => {
    if (!gw.config.demoMode) throw new GatewayError(404, "not_found", "Demo mode is off.");
    res.json({
      adminToken: gw.config.adminToken,
      tenants: DEMO_TENANTS.map((t) => ({
        id: t.id, name: t.name, plan: t.plan, apiKey: t.apiKey, allowedTiers: t.allowedTiers, profile: t.profile ?? {},
      })),
      // all backends, including ones not configured on this host, so the console can label them offline
      backends: gw.backends.map((b) => ({
        id: b.config.id, tier: b.config.tier, model: b.config.model, location: b.config.location, enabled: b.config.enabled,
      })),
      intents: gw.intents,
    });
  });

  // ---------- console static files ----------
  const webDist = gw.config.consoleDist;
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!v1\/|admin\/|api\/|healthz).*/, (_req, res) => res.sendFile(resolve(webDist, "index.html")));
  }

  // ---------- errors ----------
  app.use((req: Request, _res: Response, next: NextFunction) => next(new GatewayError(404, "not_found", `No route ${req.method} ${req.path}`)));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    let ge: GatewayError;
    if (err instanceof GatewayError) ge = err;
    else if (err instanceof ZodError) ge = new GatewayError(400, "invalid_request", zodMessage(err));
    else if (err?.type === "entity.parse.failed") ge = new GatewayError(400, "invalid_json", "Request body is not valid JSON.");
    else if (err?.type === "entity.too.large") ge = new GatewayError(413, "payload_too_large", "Request body exceeds 64kb.");
    else {
      console.error("unhandled error", err);
      ge = new GatewayError(500, "internal_error", "Internal error.");
    }
    if (res.headersSent) {
      // already streaming: best effort error event
      try {
        res.write(`event: error\ndata: ${JSON.stringify(ge.toJSON().error)}\n\n`);
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    const resetsAt = ge.details?.resetsAt;
    if (ge.status === 429 && typeof resetsAt === "string") {
      res.setHeader("retry-after", String(Math.max(1, Math.ceil((Date.parse(resetsAt) - Date.now()) / 1000))));
    }
    res.status(ge.status).json(ge.toJSON());
  });

  return app;
}
