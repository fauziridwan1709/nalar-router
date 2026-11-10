/**
 * Generic chat capability (/v1/chat/completions): the raw gateway path that product teams
 * would call for anything that isn't a packaged capability. Same auth, quota, routing,
 * fallback and metering as the support assistant; output is OpenAI-compatible.
 */
import type { ChatMessage } from "./backends/types.js";
import { BackendError } from "./errors.js";
import type { Gateway } from "./gateway.js";
import type { RunResult } from "./support/assistant.js";
import type { Tenant } from "./tenants.js";
import type { EventSink } from "./http/sink.js";
import { executeWithFallback } from "./router/executor.js";
import { planRoute, type RoutePlan } from "./router/policy.js";
import { estimateMessagesTokens } from "./tokens.js";

export function prepareChat(gw: Gateway, tenant: Tenant, messages: ChatMessage[], model?: string) {
  const estimatedPromptTokens = estimateMessagesTokens(messages);
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const plan = planRoute(
    gw.backends,
    tenant,
    // route on the size of the newest user turn; a long history alone shouldn't force the big model
    { queryTokens: Math.ceil(lastUser.length / 4), hint: model },
    gw.config.routing,
  );
  return { plan, estimatedPromptTokens };
}

export async function runChat(
  gw: Gateway,
  plan: RoutePlan,
  messages: ChatMessage[],
  ctx: {
    maxCompletionTokens: number;
    temperature?: number;
    includeReasoning?: boolean;
    sink: EventSink;
    clientSignal: AbortSignal;
    startedAt: number;
  },
): Promise<RunResult> {
  const routeReason = { rule: plan.rule, reason: plan.reason, chain: plan.chain.map((b) => b.config.id), signals: plan.signals };
  ctx.sink.emit("route", routeReason);
  let firstTokenAt: number | null = null;
  const result = await executeWithFallback({
    chain: plan.chain,
    breaker: gw.breaker,
    messages,
    maxTokens: ctx.maxCompletionTokens,
    temperature: ctx.temperature,
    clientSignal: ctx.clientSignal,
    includeReasoning: ctx.includeReasoning,
    onReasoning: (r) => ctx.sink.emit("reasoning", r),
    onAttemptStart: (a) => ctx.sink.emit("attempt", { ...a, status: "started" }),
    onAttemptEnd: (a) => ctx.sink.emit("attempt", { ...a, status: a.outcome }),
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
      outcome: "success", httpStatus: 200, attempts: result.attempts, backend: result.backend.config.id,
      model: result.backend.config.model, routeReason, latencyMs, ttftMs,
    };
  }
  const err = result.status === "failed" ? result.error : new BackendError("error", "stopped");
  const aborted = err.kind === "aborted";
  const committed = result.status === "failed" && result.committed;
  const code = aborted ? "client_aborted" : committed ? "stream_interrupted" : "all_backends_failed";
  ctx.sink.emit("error", { code, message: aborted ? "Client disconnected." : err.message, partial: committed });
  return {
    outcome: aborted ? "client_aborted" : committed ? "partial" : "failed_all_backends",
    httpStatus: aborted ? 499 : 502, attempts: result.attempts, routeReason, latencyMs, ttftMs,
    backend: result.backend?.config.id ?? null, model: result.backend?.config.model ?? null,
    errorCode: code, errorMessage: err.message,
  };
}
