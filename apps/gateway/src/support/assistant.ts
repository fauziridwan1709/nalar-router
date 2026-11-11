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
import { BackendError, GatewayError, publicAttemptError } from "../errors.js";
import { PII_LABEL, retrievalText, scanPii, summarizeCounts, type PiiFinding } from "../guardrails/pii.js";
import type { Gateway } from "../gateway.js";
import type { Tenant } from "../tenants.js";
import { executeWithFallback, StopRequest, type AttemptRecord } from "../router/executor.js";
import { planRoute, type RoutePlan } from "../router/policy.js";
import { estimateTokens } from "../tokens.js";
import { buildSupportMessages, type PromptVersion } from "./prompt.js";
import { SupportOutputParser } from "./parser.js";
import { voteShareFor, type RetrievalResult } from "./retrieval.js";
import { buildSlots, fillablePlaceholders, PlaceholderRenderer, type SlotValue } from "./placeholders.js";
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
  /** "fill" (default): resolve {{…}} slots before streaming; "raw": stream the model's text untouched */
  placeholders?: "fill" | "raw";
}

export interface Prepared {
  includeReasoning: boolean;
  /** null = raw mode */
  slots: Map<string, SlotValue> | null;
  retrieval: RetrievalResult;
  plan: RoutePlan;
  messages: ReturnType<typeof buildSupportMessages>;
  estimatedPromptTokens: number;
  /** what the PII guardrail did; values are never kept here */
  pii: { mode: string; findings: PiiFinding[]; summary: string | null };
}

/** Cheap, synchronous part (no model call): needed before admission for routing + budget. */
export function prepareSupport(gw: Gateway, tenant: Tenant, input: SupportInput): Prepared {
  // PII guardrail first: nothing below (retrieval, routing, the prompt) sees a raw value
  const policy = tenant.piiPolicy;
  const scan = policy.mode === "off" ? null : scanPii(input.message, policy.types);
  if (scan?.findings.length && policy.mode === "block") {
    const types = [...new Set(scan.findings.map((f) => f.type))];
    throw new GatewayError(
      422,
      "pii_detected",
      `The message contains personal data (${types.map((t) => PII_LABEL[t].toLowerCase()).join(", ")}). This tenant's policy blocks it; remove it and try again.`,
      { types, pii: summarizeCounts(scan.counts) },
    );
  }
  const modelText = scan ? scan.masked : input.message;
  // the retriever gets the text without masked values or their lead-ins (see retrievalText)
  const retrieval = gw.kb.search(scan ? retrievalText(modelText) : modelText, gw.config.support.topK);
  const plan = planRoute(
    gw.backends,
    tenant,
    { queryTokens: estimateTokens(modelText), retrievalTopShare: retrieval.topShare, hint: input.model },
    gw.config.routing,
  );
  const contextHits = retrieval.hits.slice(0, input.promptVersion === "v1" ? 2 : gw.config.support.contextK);
  // values the customer typed are extracted locally (order ids, amounts); masked values come back
  // through the same renderer, so the provider never sees them but the customer still does
  const slots = buildSlots(input.message, tenant.profile ?? {});
  for (const [slot, value] of scan?.readBack ?? []) slots.set(slot, { value, source: "pii" });
  const fillable = [...new Set([...fillablePlaceholders(contextHits.map((h) => h.entry.answer), slots), ...(scan?.findings.map((f) => f.slot) ?? [])])].sort();
  const messages = buildSupportMessages(input.promptVersion, modelText, contextHits, gw.intents, fillable);
  const estimatedPromptTokens = messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 2);
  return {
    retrieval, plan, messages, estimatedPromptTokens,
    includeReasoning: !!input.includeReasoning,
    slots: input.placeholders === "raw" ? null : slots,
    pii: { mode: policy.mode, findings: scan?.findings ?? [], summary: scan?.findings.length ? summarizeCounts(scan.counts) : null },
  };
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
  // types and placeholder names only: the values never leave the gateway
  sink.emit("step", {
    name: "pii_guard",
    mode: p.pii.mode,
    masked: p.pii.findings.map((f) => ({ type: f.type, label: PII_LABEL[f.type], placeholder: `{{${f.slot}}}` })),
    detail:
      p.pii.mode === "off"
        ? "PII guardrail is off for this tenant"
        : p.pii.findings.length
          ? `masked ${p.pii.findings.length} value${p.pii.findings.length === 1 ? "" : "s"} before retrieval and the model`
          : "no personal data found",
  });
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
    onAttemptEnd: (a) => sink.emit("attempt", { ...a, status: a.outcome, error: a.error ? publicAttemptError(a.outcome) : a.error }),
    consume: async (text, actx) => {
      const parser = new SupportOutputParser(validIntents);
      // fresh per attempt: a discarded attempt's partial slot state must not leak into the next one
      const renderer = p.slots ? new PlaceholderRenderer(p.slots) : null;
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
      const emitAnswer = (raw: string) => {
        const s = renderer ? renderer.push(raw) : raw;
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
      if (renderer) {
        const rest = renderer.flush();
        if (rest) {
          if (!committed) emitAnswer(rest);
          else {
            answerChars += rest.length;
            sink.emit("token", { text: rest });
          }
        }
        const filled = renderer.report();
        if (filled.length) {
          sink.emit("step", {
            name: "placeholders_rendered",
            detail: filled.map((f) => `{{${f.name}}} → ${f.source === "pii" ? "restored" : `"${f.value}"`} (${f.source})`).join("; "),
            // restored personal data goes to the answer only, never into trace events or logs
            slots: filled.map((f) => (f.source === "pii" ? { ...f, value: "(restored in the answer)" } : f)),
          });
        }
      }
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
        ? "The answer was interrupted."
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
