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
import { ChatSseSink, chatCompletionJson } from "./chatFormat.js";
import { guardChatMessages, prepareChat, runChat } from "../chat.js";

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

/**
 * OpenAI chat message: `content` may be a string or an array of text parts, and `developer` is
 * OpenAI's newer name for `system`. Both are normalised here, so everything downstream sees
 * plain {role, content} strings. Images, audio and tool calls are rejected with a clear 400.
 */
const ChatContent = z
  .unknown()
  .transform((v, ctx) => {
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.length <= 50 && v.every((p) => p?.type === "text" && typeof p.text === "string"))
      return v.map((p) => p.text as string).join("\n");
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: Array.isArray(v) ? "only text content parts are supported" : "expected a string or an array of text parts",
    });
    return z.NEVER;
  })
  .pipe(z.string().max(16_000));
const ChatMessageIn = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: ChatContent,
    name: z.string().max(64).optional(),
  })
  .strict()
  .transform((m) => ({ role: m.role === "developer" ? ("system" as const) : m.role, content: m.content }));

export const ChatBody = z
  .object({
    messages: z
      .array(ChatMessageIn)
      .min(1)
      .max(50)
      .refine((m) => m.some((x) => x.role === "user" && x.content.trim()), "at least one non-empty user message is required")
      .refine((m) => m.reduce((n, x) => n + x.content.length, 0) <= 32_000, "conversation too long (max 32k chars)"),
    model: z.string().max(64).optional(),
    /** OpenAI's default: one JSON body unless the caller asks for a stream */
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).strict().nullish(),
    max_tokens: z.number().int().min(1).max(4096).nullish(),
    /** OpenAI's newer name for max_tokens; if both are sent, this one wins */
    max_completion_tokens: z.number().int().min(1).max(4096).nullish(),
    temperature: z.number().min(0).max(2).nullish(),
    top_p: z.number().min(0).max(1).nullish(),
    stop: z.union([z.string().max(200), z.array(z.string().max(200)).max(4)]).nullish(),
    seed: z.number().int().nullish(),
    presence_penalty: z.number().min(-2).max(2).nullish(),
    frequency_penalty: z.number().min(-2).max(2).nullish(),
    n: z.literal(1, { errorMap: () => ({ message: "only n=1 is supported" }) }).nullish(),
    /** end-user id; accepted for compatibility, not stored */
    user: z.string().max(256).optional(),
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
  /** PII types and counts found in the input (type:count,…), metered with the request; never values */
  pii?: string | null;
}

const recordPii = (gw: Gateway, requestId: string, pii: unknown) => {
  if (typeof pii !== "string" || !pii) return;
  try {
    gw.db.prepare("UPDATE requests SET pii = ? WHERE id = ?").run(pii, requestId);
  } catch (e) {
    console.error(`[${requestId}] pii metering failed`, e);
  }
};

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
        if (ge.code === "pii_detected") recordPii(gw, requestId, ge.details?.pii);
      } catch {
        /* metering failure must not mask the client error */
      }
      if (ge.details?.pii) delete ge.details.pii; // the client already knows its own message; keep the response minimal
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
    recordPii(gw, requestId, spec.pii);

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
      pii: prepared.pii.summary,
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

/** POST /v1/chat/completions and the console's chat playground share this spec */
export function chatSpec(gw: Gateway, res: Response, rawBody: unknown) {
  return (tenant: Tenant): CapabilitySpec => {
    const body = ChatBody.parse(rawBody ?? {});
    const guarded = guardChatMessages(tenant, body.messages);
    const { plan, estimatedPromptTokens } = prepareChat(gw, tenant, guarded.messages, body.model);
    return {
      estimatedPromptTokens,
      pii: guarded.pii,
      requestedMaxTokens: body.max_completion_tokens ?? body.max_tokens ?? 1024,
      stream: body.stream ?? false,
      makeSink: () => new ChatSseSink(res, { includeUsage: !!body.stream_options?.include_usage }),
      run: (ctx) =>
        runChat(gw, plan, guarded.messages, {
          ...ctx,
          temperature: body.temperature ?? undefined,
          includeReasoning: body.include_reasoning,
          sampling: {
            top_p: body.top_p ?? undefined,
            stop: body.stop ?? undefined,
            seed: body.seed ?? undefined,
            presence_penalty: body.presence_penalty ?? undefined,
            frequency_penalty: body.frequency_penalty ?? undefined,
          },
        }),
      respondJson: (s, done) => chatCompletionJson(s, done),
    };
  };
}
