/**
 * Support-assistant capability: retrieval → route → generate (with fallback) → validate → stream.
 *
 * Guarantees:
 *  - Out-of-scope questions (retrieval coverage below the gate) are refused WITHOUT a
 *    model call (zero cost).
 *  - The model's header (intent + confidence) is validated before any answer text is
 *    streamed. Malformed header / unknown label / empty answer = unusable output →
 *    next backend.
 *  - Combined confidence below the threshold (or model says "unknown") → refusal and
 *    hand-off message, never a guess.
 */
import { BackendError } from "../errors.js";
import type { Gateway } from "../gateway.js";
import type { Tenant } from "../tenants.js";
import { executeWithFallback, StopRequest, type AttemptRecord } from "../router/executor.js";
import { planRoute, type RoutePlan } from "../router/policy.js";
import { estimateTokens } from "../tokens.js";
import { buildSupportMessages, type PromptVersion } from "./prompt.js";
import { SupportOutputParser } from "./parser.js";
import { voteShareFor, type RetrievalResult } from "./retrieval.js";
import type { EventSink } from "../http/sink.js";
import type { FinalRecord } from "../metering.js";

export const OUT_OF_SCOPE_MESSAGE =
  "I can only help with customer-support topics such as orders, payments, refunds, invoices, shipping, deliveries and your account. Could you rephrase your request?";
export const LOW_CONFIDENCE_MESSAGE =
  "I'm not confident I understood your request correctly, so I'd rather not guess. I'm handing this conversation to a human agent who will follow up with you shortly.";

export interface SupportInput {
  message: string;
  model?: string;
  promptVersion: PromptVersion;
  includeReasoning?: boolean;
}

export interface Prepared {
  includeReasoning: boolean;
  retrieval: RetrievalResult;
  plan: RoutePlan;
  messages: ReturnType<typeof buildSupportMessages>;
  estimatedPromptTokens: number;
}

/** Cheap, synchronous part (no model call): needed before admission for routing + budget. */
export function prepareSupport(gw: Gateway, tenant: Tenant, input: SupportInput): Prepared {
  const retrieval = gw.kb.search(input.message, gw.config.support.topK);
  const plan = planRoute(
    gw.backends,
    tenant,
    { queryTokens: estimateTokens(input.message), retrievalTopShare: retrieval.topShare, hint: input.model },
    gw.config.routing,
  );
  const contextHits = retrieval.hits.slice(0, input.promptVersion === "v1" ? 2 : gw.config.support.contextK);
  const messages = buildSupportMessages(input.promptVersion, input.message, contextHits, gw.intents);
  const estimatedPromptTokens = messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 2);
  return { retrieval, plan, messages, estimatedPromptTokens, includeReasoning: !!input.includeReasoning };
}

export function confidenceOf(r: RetrievalResult, intent: string, modelConfidence: number) {
  const vote = voteShareFor(r, intent);
  const value = 0.45 * vote + 0.35 * r.coverage + 0.2 * modelConfidence;
  return {
    value: Math.round(value * 1000) / 1000,
    label: value >= 0.75 ? "high" : value >= 0.5 ? "medium" : "low",
    components: { retrievalVote: round(vote), coverage: round(r.coverage), model: round(modelConfidence) },
  };
}
const round = (x: number) => Math.round(x * 1000) / 1000;

export interface RunResult extends FinalRecord {
  attempts: AttemptRecord[];
}

export async function runSupport(
  gw: Gateway,
  p: Prepared,
  ctx: { maxCompletionTokens: number; sink: EventSink; clientSignal: AbortSignal; startedAt: number },
): Promise<RunResult> {
  const { retrieval, plan } = p;
  const { sink } = ctx;
  const routeReason = { rule: plan.rule, reason: plan.reason, chain: plan.chain.map((b) => b.config.id), signals: plan.signals };
  sink.emit("route", routeReason);
  sink.emit("retrieval", {
    coverage: round(retrieval.coverage),
    topIntent: retrieval.topIntent,
    votes: retrieval.votes.slice(0, 5).map((v) => ({ intent: v.intent, share: round(v.share) })),
    entries: retrieval.hits.slice(0, gw.config.support.contextK).map((h) => ({
      id: h.entry.id, intent: h.entry.intent, score: round(h.score), question: h.entry.question, answer: h.entry.answer,
    })),
  });

  const base = { routeReason, latencyMs: 0 };
  const gated =
    retrieval.coverage < gw.config.support.minCoverage && retrieval.queryTerms.length <= gw.config.support.gateMaxTerms;
  sink.emit("step", {
    name: "scope_gate",
    passed: !gated,
    detail: gated
      ? `short message (${retrieval.queryTerms.length} terms) with coverage ${round(retrieval.coverage)} < ${gw.config.support.minCoverage}: refuse without a model call`
      : retrieval.queryTerms.length > gw.config.support.gateMaxTerms
        ? `long message (${retrieval.queryTerms.length} terms): lexical gate skipped, model decides scope`
        : `coverage ${round(retrieval.coverage)} ≥ ${gw.config.support.minCoverage}: in scope`,
  });
  if (gated) {
    sink.emit("refusal", { reason: "out_of_scope", message: OUT_OF_SCOPE_MESSAGE, coverage: round(retrieval.coverage) });
    return {
      ...base, outcome: "refused_out_of_scope", httpStatus: 200, attempts: [], intent: null,
      confidence: round(retrieval.coverage), latencyMs: Date.now() - ctx.startedAt,
    };
  }

  const validIntents = new Set([...gw.intents, "unknown"]);
  const topEntry = retrieval.hits.find((h) => h.entry.intent === retrieval.topIntent)?.entry;
  let firstTokenAt: number | null = null;
  let finalIntent: string | null = null;
  let finalConfidence: number | null = null;
  let answerChars = 0;

  const result = await executeWithFallback({
    chain: plan.chain,
    breaker: gw.breaker,
    messages: p.messages,
    maxTokens: Math.min(
      gw.config.support.maxAnswerTokens + (p.includeReasoning ? gw.config.support.reasoningExtraTokens : 0),
      ctx.maxCompletionTokens,
    ),
    temperature: 0.2,
    clientSignal: ctx.clientSignal,
    includeReasoning: p.includeReasoning,
    onReasoning: (r) => sink.emit("reasoning", r),
    hints: topEntry
      ? { extractive: { intent: topEntry.intent, answer: topEntry.answer, confidence: retrieval.topShare } }
      : undefined,
    onAttemptStart: (a) => sink.emit("attempt", { ...a, status: "started" }),
    onAttemptEnd: (a) => sink.emit("attempt", { ...a, status: a.outcome }),
    consume: async (text, actx) => {
      const parser = new SupportOutputParser(validIntents);
      let decided: { intent: string; conf: ReturnType<typeof confidenceOf>; modelConfidence: number } | null = null;
      let committed = false;
      const decide = () => {
        const h = parser.parsedHeader!;
        sink.emit("step", {
          name: "header_validated",
          backend: actx.backend.config.id,
          detail: `model said intent=${h.intent}, self-confidence ${h.modelConfidence}`,
        });
        if (h.intent === "unknown") throw new StopRequest("model classified the message as out of scope");
        const conf = confidenceOf(retrieval, h.intent, h.modelConfidence);
        if (conf.value < gw.config.support.refuseBelow) {
          finalIntent = h.intent;
          finalConfidence = conf.value;
          throw new StopRequest(`confidence ${conf.value} below threshold ${gw.config.support.refuseBelow}`);
        }
        decided = { intent: h.intent, conf, modelConfidence: h.modelConfidence };
      };
      const emitAnswer = (s: string) => {
        if (!s) return;
        if (!committed) {
          if (!s.trim()) return; // don't commit on whitespace
          const d = decided!;
          sink.emit("intent", {
            intent: d.intent,
            confidence: d.conf.value,
            label: actx.backend.config.tier === "degraded" ? `${d.conf.label} (degraded: extractive)` : d.conf.label,
            components: d.conf.components,
            agreesWithRetrieval: d.intent === retrieval.topIntent,
          });
          actx.commit();
          committed = true;
          firstTokenAt = Date.now();
          finalIntent = d.intent;
          finalConfidence = d.conf.value;
        }
        answerChars += s.length;
        sink.emit("token", { text: s });
      };

      for await (const chunk of text) {
        const out = parser.push(chunk);
        if (parser.hasHeader && !decided) decide();
        emitAnswer(out);
      }
      const tail = parser.end();
      if (!decided) decide();
      emitAnswer(tail);
      if (!committed) throw new BackendError("unusable_output", "model returned a header but an empty answer");
    },
  });

  const latencyMs = Date.now() - ctx.startedAt;
  const ttftMs = firstTokenAt ? firstTokenAt - ctx.startedAt : null;
  const final = result.backend;

  if (result.status === "ok") {
    return {
      ...base, outcome: "success", httpStatus: 200, attempts: result.attempts, backend: final!.config.id,
      model: final!.config.model, latencyMs, ttftMs, intent: finalIntent, confidence: finalConfidence,
    };
  }
  if (result.status === "stopped") {
    const lowConf = result.reason.startsWith("confidence");
    sink.emit("refusal", {
      reason: lowConf ? "low_confidence" : "out_of_scope",
      detail: result.reason,
      message: lowConf ? LOW_CONFIDENCE_MESSAGE : OUT_OF_SCOPE_MESSAGE,
      intent: finalIntent,
      confidence: finalConfidence,
    });
    return {
      ...base, outcome: lowConf ? "refused_low_confidence" : "refused_out_of_scope", httpStatus: 200,
      attempts: result.attempts, backend: final!.config.id, model: final!.config.model, latencyMs,
      intent: finalIntent, confidence: finalConfidence,
    };
  }
  const aborted = result.error.kind === "aborted";
  const code = aborted ? "client_aborted" : result.committed ? "stream_interrupted" : "all_backends_failed";
  sink.emit("error", {
    code,
    message: aborted
      ? "Client disconnected."
      : result.committed
        ? `The answer was interrupted: ${result.error.message}`
        : "All model backends failed or returned unusable output.",
    partial: result.committed,
  });
  return {
    ...base, outcome: aborted ? "client_aborted" : result.committed ? "partial" : "failed_all_backends",
    httpStatus: aborted ? 499 : 502, attempts: result.attempts,
    backend: result.backend?.config.id ?? null, model: result.backend?.config.model ?? null,
    latencyMs, ttftMs, intent: finalIntent, confidence: finalConfidence, errorCode: code,
    errorMessage: result.error.message + (answerChars ? ` (after ${answerChars} chars streamed)` : ""),
  };
}
