/**
 * The shared request path for every model-calling endpoint: validate, admit against quota
 * (fail closed), run, meter, respond. The public API (API key) and the console playground
 * (signed-in user) both go through here, so they can't drift apart on quota or metering.
 */
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z, ZodError } from "zod";
import type { Gateway } from "../gateway.js";
import { GatewayError } from "../errors.js";
import type { Tenant } from "../tenants.js";
import { admit, getUsage } from "../quota.js";
import { finishRequest, recordRejected } from "../metering.js";
import { prepareSupport, runSupport, type RunResult } from "../support/assistant.js";
import { CollectSink, SseSink, type EventSink } from "./sink.js";
import type { ChatSseSink } from "./chatFormat.js";

export const SupportBody = z
  .object({
    message: z.string().trim().min(1, "message must not be empty").max(2000, "message too long (max 2000 chars)"),
    model: z.string().max(64).optional(),
    prompt_version: z.enum(["v1", "v2", "v3"]).optional(),
    placeholders: z.enum(["fill", "raw"]).optional(),
    stream: z.boolean().optional(),
    include_reasoning: z.boolean().optional(),
  })
  .strict();

export function zodMessage(e: ZodError) {
  return e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

export interface CapabilitySpec {
  estimatedPromptTokens: number;
  requestedMaxTokens: number;
  promptVersion?: string;
  stream: boolean;
  makeSink: () => EventSink;
  run: (ctx: { maxCompletionTokens: number; sink: EventSink; clientSignal: AbortSignal; startedAt: number }) => Promise<RunResult>;
  respondJson: (sink: CollectSink, done: any) => unknown;
}

export function createCapabilityRunner(gw: Gateway) {
  return async function runCapability(
    req: Request,
    res: Response,
    endpoint: string,
    who: { tenant: Tenant; credential: string },
    build: (tenant: Tenant) => CapabilitySpec,
  ) {
    const { tenant, credential } = who;
    const requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    res.setHeader("x-request-id", requestId);

    let spec: CapabilitySpec;
    try {
      spec = build(tenant);
    } catch (e) {
      const ge =
        e instanceof ZodError
          ? new GatewayError(400, "invalid_request", zodMessage(e))
          : e instanceof GatewayError
            ? e
            : new GatewayError(500, "internal_error", "Failed to prepare request.");
      if (!(e instanceof ZodError) && !(e instanceof GatewayError)) console.error(`[${requestId}] prepare failed`, e);
      try {
        recordRejected(gw.db, requestId, tenant.id, endpoint, ge.status, ge.code, ge.message, credential);
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
      credential,
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
  };
}

export type RunCapability = ReturnType<typeof createCapabilityRunner>;

/** POST /v1/support/answer and the console playground share this spec */
export function supportSpec(gw: Gateway, res: Response, rawBody: unknown) {
  return (tenant: Tenant): CapabilitySpec => {
    const body = SupportBody.parse(rawBody ?? {});
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
      requestedMaxTokens: gw.config.support.maxAnswerTokens + (body.include_reasoning ? gw.config.support.reasoningExtraTokens : 0),
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
  };
}
