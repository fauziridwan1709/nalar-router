/**
 * Generic chat capability (/v1/chat/completions): the raw gateway path that product teams
 * would call for anything that isn't a packaged capability. Same auth, quota, routing,
 * fallback and metering as the support assistant; output is OpenAI-compatible.
 */
import type { ChatMessage, Sampling } from "./ports/backend.js";
import { BackendError, publicAttemptError, type ErrorCode } from "../entities/errors.js";
import type { AppDeps } from "./deps.js";
import type { RunResult } from "./capability.js";
import type { Tenant } from "../entities/types.js";
import type { EventSink } from "./ports/sink.js";
import { executeWithFallback } from "./executor.js";
import { planRoute, type RouteSignals } from "../entities/routing/policy.js";
import { resolveRoute } from "./router.js";
import { estimateMessagesTokens } from "../entities/tokens.js";
import { GatewayError } from "../entities/errors.js";
import { PII_LABEL, scanPii, summarizeCounts, type PiiType } from "../entities/guardrails/pii.js";

/**
 * The raw path applies the same PII policy to every message. Masked values stay masked: there is
 * no template renderer here, so a model that repeats {{Customer Email}} shows it as written.
 */
export function guardChatMessages(tenant: Tenant, messages: ChatMessage[]) {
  const policy = tenant.piiPolicy;
  if (policy.mode === "off") return { messages, pii: null as string | null };
  const counts: Partial<Record<PiiType, number>> = {};
  const out = messages.map((m) => {
    const s = scanPii(m.content, policy.types);
    for (const [t, n] of Object.entries(s.counts)) counts[t as PiiType] = (counts[t as PiiType] ?? 0) + (n ?? 0);
    return { ...m, content: s.masked };
  });
  const types = Object.keys(counts) as PiiType[];
  if (types.length && policy.mode === "block") {
    throw new GatewayError(422, "pii_detected",
      `The messages contain personal data (${types.map((t) => PII_LABEL[t].toLowerCase()).join(", ")}). This tenant's policy blocks it; remove it and try again.`,
      { types, pii: summarizeCounts(counts) });
  }
  return { messages: out, pii: types.length ? summarizeCounts(counts) : null };
}

/** `completionTokens`: the caller's max_tokens, which must fit in the model's context next to the messages */
export function prepareChat(deps: AppDeps, tenant: Tenant, messages: ChatMessage[], model: string | undefined, completionTokens: number) {
  const estimatedPromptTokens = estimateMessagesTokens(messages);
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  // route on the size of the newest user turn; a long history alone shouldn't force the big model
  const routeSignals: RouteSignals = {
    queryTokens: Math.ceil(lastUser.length / 4), text: lastUser, turns: messages.length, hint: model,
    context: { promptTokens: estimatedPromptTokens, completionTokens },
  };
  const plan = planRoute(deps.backends, tenant, routeSignals, deps.config.routing);
  return { plan, tenant, routeSignals, estimatedPromptTokens };
}

export type PreparedChat = ReturnType<typeof prepareChat>;

export async function runChat(
  deps: AppDeps,
  prepared: Pick<PreparedChat, "plan" | "tenant" | "routeSignals">,
  messages: ChatMessage[],
  ctx: {
    maxCompletionTokens: number;
    temperature?: number;
    sampling?: Sampling;
    includeReasoning?: boolean;
    sink: EventSink;
    clientSignal: AbortSignal;
    startedAt: number;
  },
): Promise<RunResult> {
  // auto-smart classifies first (metered as attempt 0); other modes return the plan as is
  const { plan, attempts: routeAttempts } = await resolveRoute(deps, prepared.tenant, prepared.routeSignals, prepared.plan, ctx);
  for (const a of routeAttempts) {
    ctx.sink.emit("attempt", { ...a, status: a.outcome, error: a.error ? publicAttemptError(a.outcome) : a.error });
  }
  const routeReason = { rule: plan.rule, reason: plan.reason, mode: plan.mode, chain: plan.chain.map((b) => b.config.id), signals: plan.signals };
  ctx.sink.emit("route", routeReason);
  let firstTokenAt: number | null = null;
  const result = await executeWithFallback({
    chain: plan.chain,
    breaker: deps.breaker,
    messages,
    maxTokens: ctx.maxCompletionTokens,
    temperature: ctx.temperature,
    sampling: ctx.sampling,
    clientSignal: ctx.clientSignal,
    includeReasoning: ctx.includeReasoning,
    onReasoning: (r) => ctx.sink.emit("reasoning", r),
    onAttemptStart: (a) => ctx.sink.emit("attempt", { ...a, status: "started" }),
    onAttemptEnd: (a) => ctx.sink.emit("attempt", { ...a, status: a.outcome, error: a.error ? publicAttemptError(a.outcome) : a.error }),
    consume: async (text, actx) => {
      let committed = false;
      for await (const t of text) {
        if (!committed) {
          if (!t.trim()) continue;
          actx.commit();
          committed = true;
          firstTokenAt = Date.now();
          ctx.sink.emit("model", { backend: actx.backend.config.id, model: actx.backend.config.model });
        }
        ctx.sink.emit("token", { text: t });
      }
      if (!committed) throw new BackendError("unusable_output", "empty completion");
    },
  });
  const latencyMs = Date.now() - ctx.startedAt;
  const ttftMs = firstTokenAt ? firstTokenAt - ctx.startedAt : null;
  if (result.status === "ok") {
    return {
      outcome: "success", httpStatus: 200, attempts: [...routeAttempts, ...result.attempts], backend: result.backend.config.id,
      model: result.backend.config.model, routeReason, latencyMs, ttftMs,
    };
  }
  const err = result.status === "failed" ? result.error : new BackendError("error", "stopped");
  const aborted = err.kind === "aborted";
  const committed = result.status === "failed" && result.committed;
  const code: ErrorCode = aborted ? "client_aborted" : committed ? "stream_interrupted" : "all_backends_failed";
  ctx.sink.emit("error", {
    code,
    message: aborted ? "Client disconnected." : committed ? "The answer was interrupted." : "All model backends failed.",
    partial: committed,
  });
  return {
    outcome: aborted ? "client_aborted" : committed ? "partial" : "failed_all_backends",
    httpStatus: aborted ? 499 : 502, attempts: [...routeAttempts, ...result.attempts], routeReason, latencyMs, ttftMs,
    backend: result.backend?.config.id ?? null, model: result.backend?.config.model ?? null,
    errorCode: code, errorMessage: err.message,
  };
}
