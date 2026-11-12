/**
 * HTTP controller for the capability use case (use-cases/capability.ts): request schemas, the
 * spec builders that turn a validated body into a CapabilitySpec with the right wire format,
 * and the Express transport. The public API (API key) and the console playground use the same
 * builders, so their validation and output can't drift apart.
 */
import type { Request, Response } from "express";
import { z, ZodError } from "zod";
import { GatewayError } from "../../../entities/errors.js";
import { LIMITS } from "../../../entities/limits.js";
import type { Tenant } from "../../../entities/types.js";
import type { AppDeps } from "../../../use-cases/deps.js";
import { runCapability, type CapabilitySpec, type CapabilityTransport } from "../../../use-cases/capability.js";
import { prepareSupport, runSupport } from "../../../use-cases/support.js";
import { guardChatMessages, prepareChat, runChat } from "../../../use-cases/chat.js";
import { SseSink } from "../../presenters/sse.js";
import { ChatSseSink, chatCompletionJson } from "../../presenters/openaiChat.js";

export const SupportBody = z
  .object({
    message: z.string().trim().min(1, "message must not be empty").max(LIMITS.supportMessageChars, `message too long (max ${LIMITS.supportMessageChars} chars)`),
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
  .pipe(z.string().max(LIMITS.chatMessageChars, `message too long (max ${LIMITS.chatMessageChars} chars)`));
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
      .max(LIMITS.chatMaxMessages)
      .refine((m) => m.some((x) => x.role === "user" && x.content.trim()), "at least one non-empty user message is required")
      .refine((m) => m.reduce((n, x) => n + x.content.length, 0) <= LIMITS.chatTotalChars, `conversation too long (max ${LIMITS.chatTotalChars} chars)`),
    model: z.string().max(64).optional(),
    /** OpenAI's default: one JSON body unless the caller asks for a stream */
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).strict().nullish(),
    max_tokens: z.number().int().min(1).max(LIMITS.maxCompletionTokens).nullish(),
    /** OpenAI's newer name for max_tokens; if both are sent, this one wins */
    max_completion_tokens: z.number().int().min(1).max(LIMITS.maxCompletionTokens).nullish(),
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

/** "messages.0.role: Invalid enum value…; stream: Expected boolean" */
export function zodMessage(e: ZodError) {
  return e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

/** validates a body against a schema; failures become 400 invalid_request naming each field */
export function parseBody<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw new GatewayError(400, "invalid_request", zodMessage(r.error));
  return r.data;
}

/** Express side of a capability request: x-request-id, disconnect → abort, JSON response */
export function expressTransport(res: Response): CapabilityTransport {
  const client = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) client.abort();
  });
  return {
    begin: (requestId) => res.setHeader("x-request-id", requestId),
    clientSignal: client.signal,
    respond: (status, body) => {
      if (!res.headersSent) res.status(status).json(body);
    },
  };
}

/** binds the use case to the composed dependencies, for the route handlers */
export function createCapabilityRunner(deps: AppDeps) {
  return (req: Request, res: Response, endpoint: string, who: { tenant: Tenant; credential: string }, build: (tenant: Tenant) => CapabilitySpec) =>
    runCapability(deps, expressTransport(res), endpoint, who, build);
}

export type RunCapability = ReturnType<typeof createCapabilityRunner>;

/** POST /v1/support/answer and the console playground share this spec */
export function supportSpec(deps: AppDeps, res: Response, rawBody: unknown) {
  return (tenant: Tenant): CapabilitySpec => {
    const body = parseBody(SupportBody, rawBody);
    const promptVersion = body.prompt_version ?? deps.config.support.defaultPromptVersion;
    const prepared = prepareSupport(deps, tenant, {
      message: body.message,
      model: body.model,
      promptVersion,
      includeReasoning: body.include_reasoning,
      placeholders: body.placeholders,
    });
    return {
      estimatedPromptTokens: prepared.estimatedPromptTokens,
      requestedMaxTokens: deps.config.support.maxAnswerTokens + (body.include_reasoning ? deps.config.support.reasoningExtraTokens : 0),
      promptVersion,
      pii: prepared.pii.summary,
      stream: body.stream ?? true,
      makeSink: () => new SseSink(res),
      run: (ctx) => runSupport(deps, prepared, ctx),
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
export function chatSpec(deps: AppDeps, res: Response, rawBody: unknown) {
  return (tenant: Tenant): CapabilitySpec => {
    const body = parseBody(ChatBody, rawBody);
    const requestedMaxTokens = body.max_completion_tokens ?? body.max_tokens ?? LIMITS.chatDefaultCompletionTokens;
    const guarded = guardChatMessages(tenant, body.messages);
    const prepared = prepareChat(deps, tenant, guarded.messages, body.model, requestedMaxTokens);
    const { estimatedPromptTokens } = prepared;
    return {
      estimatedPromptTokens,
      pii: guarded.pii,
      requestedMaxTokens,
      stream: body.stream ?? false,
      makeSink: () => new ChatSseSink(res, { includeUsage: !!body.stream_options?.include_usage }),
      run: (ctx) =>
        runChat(deps, prepared, guarded.messages, {
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
