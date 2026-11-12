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
import { BackendError, GatewayError } from "../entities/errors.js";
import { PII_LABEL, retrievalText, scanPii, summarizeCounts, type PiiFinding } from "../entities/guardrails/pii.js";
import type { AppDeps, SupportSettings } from "./deps.js";
import type { EventSink } from "./ports/sink.js";
import type { AttemptRecord } from "../entities/metering.js";
import { attemptEvent, failureOf, routeEvent } from "./events.js";
import type { Backend } from "./ports/backend.js";
import type { Tenant } from "../entities/types.js";
import { executeWithFallback, StopRequest, type ConsumeContext, type ExecuteResult } from "./executor.js";
import { planRoute, type RoutePlan, type RouteSignals } from "../entities/routing/policy.js";
import { cascadeEscalation } from "../entities/routing/cascade.js";
import { resolveRoute } from "./router.js";
import { estimateTokens } from "../entities/tokens.js";
import { buildSupportMessages, type PromptVersion } from "../entities/support/prompt.js";
import { SupportOutputParser } from "../entities/support/parser.js";
import type { RetrievalResult } from "../entities/support/retrieval.js";
import { confidenceOf, type Confidence } from "../entities/support/confidence.js";
import {
  buildSlots,
  fillablePlaceholders,
  PlaceholderRenderer,
  type SlotValue,
} from "../entities/support/placeholders.js";
import type { RunContext, RunResult } from "./capability.js";
export type { RunResult };
export { confidenceOf };

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
  plan: RoutePlan<Backend>;
  /** kept so auto-smart can re-plan once the classifier has run */
  tenant: Tenant;
  routeSignals: RouteSignals;
  messages: ReturnType<typeof buildSupportMessages>;
  estimatedPromptTokens: number;
  /** what the PII guardrail did; values are never kept here */
  pii: { mode: string; findings: PiiFinding[]; summary: string | null };
}

/** tokens reserved for a support answer; reasoning models need room to think before they answer */
export const answerBudget = (settings: SupportSettings, includeReasoning: boolean) =>
  settings.maxAnswerTokens + (includeReasoning ? settings.reasoningExtraTokens : 0);

/** Cheap, synchronous part (no model call): needed before admission for routing + budget. */
export function prepareSupport(deps: AppDeps, tenant: Tenant, input: SupportInput): Prepared {
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
  const retrieval = deps.kb.search(scan ? retrievalText(modelText) : modelText, deps.config.support.topK);
  const contextHits = retrieval.hits.slice(0, input.promptVersion === "v1" ? 2 : deps.config.support.contextK);
  // values the customer typed are extracted locally (order ids, amounts); masked values come back
  // through the same renderer, so the provider never sees them but the customer still does
  const slots = buildSlots(input.message, tenant.profile ?? {});
  for (const [slot, value] of scan?.readBack ?? []) slots.set(slot, { value, source: "pii" });
  const fillable = [
    ...new Set([
      ...fillablePlaceholders(
        contextHits.map((h) => h.entry.answer),
        slots,
      ),
      ...(scan?.findings.map((f) => f.slot) ?? []),
    ]),
  ].sort();
  const messages = buildSupportMessages(input.promptVersion, modelText, contextHits, deps.intents, fillable);
  const estimatedPromptTokens = messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 2);
  const support = deps.config.support;
  const routeSignals: RouteSignals = {
    queryTokens: estimateTokens(modelText),
    text: modelText,
    retrievalTopShare: retrieval.topShare,
    hint: input.model,
    cascadeCapable: true,
    // the prompt (instructions + KB context + message) and the answer budget must fit the model's window
    context: { promptTokens: estimatedPromptTokens, completionTokens: answerBudget(support, !!input.includeReasoning) },
  };
  const plan = planRoute(deps.backends, tenant, routeSignals, deps.config.routing);
  return {
    retrieval,
    plan,
    tenant,
    routeSignals,
    messages,
    estimatedPromptTokens,
    includeReasoning: !!input.includeReasoning,
    slots: input.placeholders === "raw" ? null : slots,
    pii: {
      mode: policy.mode,
      findings: scan?.findings ?? [],
      summary: scan?.findings.length ? summarizeCounts(scan.counts) : null,
    },
  };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * The expensive part, after admission: trace the guardrail and retrieval, refuse out-of-scope
 * messages without a model call, classify for auto-smart, then run the chain with fallback.
 */
export async function runSupport(deps: AppDeps, prepared: Prepared, ctx: RunContext): Promise<RunResult> {
  const { sink } = ctx;
  const settings = deps.config.support;
  emitGuardrailStep(sink, prepared.pii);
  // auto-smart's route is known only after the classifier runs, past the scope gate
  if (!prepared.plan.needsClassifier) sink.emit("route", routeEvent(prepared.plan));
  emitRetrieval(sink, prepared.retrieval, settings.contextK);

  const gate = scopeGate(prepared.retrieval, settings);
  sink.emit("step", { name: "scope_gate", passed: !gate.refuse, detail: gate.detail });
  if (gate.refuse) {
    sink.emit("refusal", {
      reason: "out_of_scope",
      message: OUT_OF_SCOPE_MESSAGE,
      coverage: round3(prepared.retrieval.coverage),
    });
    return {
      outcome: "refused_out_of_scope",
      httpStatus: 200,
      attempts: [],
      routeReason: routeEvent(prepared.plan),
      intent: null,
      confidence: round3(prepared.retrieval.coverage),
      latencyMs: Date.now() - ctx.startedAt,
    };
  }

  // auto-smart: classify (metered as attempt 0), then route on the verdict; other modes pass through
  const { plan, attempts: routeAttempts } = await resolveRoute(
    deps,
    prepared.tenant,
    prepared.routeSignals,
    prepared.plan,
    ctx,
  );
  if (prepared.plan.needsClassifier) {
    for (const attempt of routeAttempts) sink.emit("attempt", attemptEvent(attempt));
    sink.emit("route", routeEvent(plan));
  }

  const answer: AnswerSoFar = { intent: null, confidence: null, firstTokenAt: null, chars: 0 };
  const topEntry = prepared.retrieval.hits.find((h) => h.entry.intent === prepared.retrieval.topIntent)?.entry;
  const result = await executeWithFallback({
    chain: plan.chain,
    breaker: deps.breaker,
    messages: prepared.messages,
    maxTokens: Math.min(answerBudget(settings, prepared.includeReasoning), ctx.maxCompletionTokens),
    temperature: 0.2,
    clientSignal: ctx.clientSignal,
    includeReasoning: prepared.includeReasoning,
    // the extractive backend answers with the best-matching KB entry
    hints: topEntry
      ? { extractive: { intent: topEntry.intent, answer: topEntry.answer, confidence: prepared.retrieval.topShare } }
      : undefined,
    onReasoning: (r) => sink.emit("reasoning", r),
    onAttemptStart: (a) => sink.emit("attempt", { ...a, status: "started" }),
    onAttemptEnd: (a) => sink.emit("attempt", attemptEvent(a)),
    consume: (text, attempt) => new SupportAttempt(deps, prepared, plan, attempt, sink, answer).run(text),
  });
  return toRunResult(result, routeAttempts, answer, routeEvent(plan), ctx, sink);
}

/** what the run has sent so far, shared across attempts (only the committed attempt writes the answer) */
interface AnswerSoFar {
  intent: string | null;
  confidence: number | null;
  firstTokenAt: number | null;
  /** characters streamed, for the error message when a stream breaks */
  chars: number;
}

/** types and placeholder names only: the values never leave the gateway */
function emitGuardrailStep(sink: EventSink, pii: Prepared["pii"]) {
  const count = pii.findings.length;
  sink.emit("step", {
    name: "pii_guard",
    mode: pii.mode,
    masked: pii.findings.map((f) => ({ type: f.type, label: PII_LABEL[f.type], placeholder: `{{${f.slot}}}` })),
    detail:
      pii.mode === "off"
        ? "PII guardrail is off for this tenant"
        : count
          ? `masked ${count} value${count === 1 ? "" : "s"} before retrieval and the model`
          : "no personal data found",
  });
}

function emitRetrieval(sink: EventSink, retrieval: RetrievalResult, contextK: number) {
  sink.emit("retrieval", {
    coverage: round3(retrieval.coverage),
    topIntent: retrieval.topIntent,
    votes: retrieval.votes.slice(0, 5).map((v) => ({ intent: v.intent, share: round3(v.share) })),
    entries: retrieval.hits.slice(0, contextK).map((h) => ({
      id: h.entry.id,
      intent: h.entry.intent,
      score: round3(h.score),
      question: h.entry.question,
      answer: h.entry.answer,
    })),
  });
}

/**
 * The lexical scope gate: a short message the knowledge base barely recognises is off-topic, and
 * is refused without paying for a model call. Long messages dilute coverage with extra words, so
 * for them the model decides scope instead.
 */
function scopeGate(retrieval: RetrievalResult, settings: SupportSettings): { refuse: boolean; detail: string } {
  const terms = retrieval.queryTerms.length;
  const coverage = round3(retrieval.coverage);
  if (terms > settings.gateMaxTerms) {
    return { refuse: false, detail: `long message (${terms} terms): lexical gate skipped, model decides scope` };
  }
  if (retrieval.coverage < settings.minCoverage) {
    return {
      refuse: true,
      detail: `short message (${terms} terms) with coverage ${coverage} < ${settings.minCoverage}: refuse without a model call`,
    };
  }
  return { refuse: false, detail: `coverage ${coverage} ≥ ${settings.minCoverage}: in scope` };
}

interface Decision {
  intent: string;
  confidence: Confidence;
}

/**
 * One attempt at a support answer. The model writes a header ({"intent","confidence"} then ###)
 * and then the answer. Nothing reaches the client until the header has been checked, so a bad
 * header, a cascade escalation or a refusal costs no splice. A fresh instance per attempt keeps a
 * discarded attempt's parser and placeholder state out of the next one.
 */
class SupportAttempt {
  private readonly parser: SupportOutputParser;
  private readonly renderer: PlaceholderRenderer | null;
  private decision: Decision | null = null;
  private committed = false;

  constructor(
    private readonly deps: AppDeps,
    private readonly prepared: Prepared,
    private readonly plan: RoutePlan<Backend>,
    private readonly attempt: ConsumeContext,
    private readonly sink: EventSink,
    private readonly answer: AnswerSoFar,
  ) {
    this.parser = new SupportOutputParser(new Set([...deps.intents, "unknown"]));
    this.renderer = prepared.slots ? new PlaceholderRenderer(prepared.slots) : null;
  }

  async run(text: AsyncIterable<string>) {
    for await (const chunk of text) {
      const answerText = this.parser.push(chunk);
      if (this.parser.hasHeader && !this.decision) this.decide();
      this.render(answerText);
    }
    const tail = this.parser.end();
    if (!this.decision) this.decide();
    this.render(tail);
    this.flushPlaceholders();
    if (!this.committed) throw new BackendError("unusable_output", "model returned a header but an empty answer");
  }

  /** read the header: escalate (cascade), refuse, or accept the intent */
  private decide() {
    const header = this.parser.parsedHeader!;
    const backend = this.attempt.backend.config;
    const { retrieval } = this.prepared;
    const settings = this.deps.config.support;
    this.sink.emit("step", {
      name: "header_validated",
      backend: backend.id,
      detail: `model said intent=${header.intent}, self-confidence ${header.modelConfidence}`,
    });
    const confidence = confidenceOf(retrieval, header.intent, header.modelConfidence);
    this.escalateIfUnsure(header, confidence);
    if (header.intent === "unknown") {
      throw new StopRequest("out_of_scope", "model classified the message as out of scope");
    }
    if (confidence.value < settings.refuseBelow) {
      this.answer.intent = header.intent;
      this.answer.confidence = confidence.value;
      throw new StopRequest("low_confidence", `confidence ${confidence.value} below threshold ${settings.refuseBelow}`);
    }
    this.decision = { intent: header.intent, confidence };
  }

  /** auto-cascade: drop a fast attempt that doubts itself, before anything was sent, if strong is still ahead */
  private escalateIfUnsure(header: { intent: string; modelConfidence: number }, confidence: Confidence) {
    const backend = this.attempt.backend;
    if (this.plan.mode !== "cascade" || backend.config.tier !== "fast" || !this.strongStillAhead(backend)) return;
    const { retrieval } = this.prepared;
    const why = cascadeEscalation({
      intent: header.intent,
      modelConfidence: header.modelConfidence,
      confidence: confidence.value,
      topIntent: retrieval.topIntent,
      ceiling: confidenceOf(retrieval, retrieval.topIntent ?? "", 1).value,
      refuseBelow: this.deps.config.support.refuseBelow,
      modelConfidenceBelow: this.deps.config.routing.cascadeModelConfidenceBelow,
    });
    if (!why) return;
    this.sink.emit("step", {
      name: "cascade_escalated",
      backend: backend.config.id,
      detail: `${why}: dropping this attempt before anything was sent, moving up to strong`,
    });
    throw new BackendError("escalated", why);
  }

  private strongStillAhead(backend: Backend) {
    const rest = this.plan.chain.slice(this.plan.chain.indexOf(backend) + 1);
    return rest.some((b) => b.config.tier === "strong" && !this.deps.breaker.isOpen(b.config.id));
  }

  /** fill placeholders in the model's text, then send it */
  private render(modelText: string) {
    this.send(this.renderer ? this.renderer.push(modelText) : modelText);
  }

  /** the first non-blank text is the commit point: the intent goes out, and fallback is no longer possible */
  private send(text: string) {
    if (!text) return;
    if (!this.committed) {
      if (!text.trim()) return;
      this.commit();
    }
    this.answer.chars += text.length;
    this.sink.emit("token", { text });
  }

  private commit() {
    const decision = this.decision!;
    const degraded = this.attempt.backend.config.tier === "degraded";
    this.sink.emit("intent", {
      intent: decision.intent,
      confidence: decision.confidence.value,
      label: degraded ? `${decision.confidence.label} (degraded: extractive)` : decision.confidence.label,
      components: decision.confidence.components,
      agreesWithRetrieval: decision.intent === this.prepared.retrieval.topIntent,
    });
    this.attempt.commit();
    this.committed = true;
    this.answer.firstTokenAt = Date.now();
    this.answer.intent = decision.intent;
    this.answer.confidence = decision.confidence.value;
  }

  /** send what the renderer held back, and trace which placeholders were filled from where */
  private flushPlaceholders() {
    if (!this.renderer) return;
    this.send(this.renderer.flush());
    const filled = this.renderer.report();
    if (!filled.length) return;
    this.sink.emit("step", {
      name: "placeholders_rendered",
      detail: filled
        .map((f) => `{{${f.name}}} → ${f.source === "pii" ? "restored" : `"${f.value}"`} (${f.source})`)
        .join("; "),
      // restored personal data goes to the answer only, never into trace events or logs
      slots: filled.map((f) => (f.source === "pii" ? { ...f, value: "(restored in the answer)" } : f)),
    });
  }
}

/** the run's outcome for metering and the `done` event */
function toRunResult(
  result: ExecuteResult,
  routeAttempts: AttemptRecord[],
  answer: AnswerSoFar,
  routeReason: ReturnType<typeof routeEvent>,
  ctx: RunContext,
  sink: EventSink,
): RunResult {
  const latencyMs = Date.now() - ctx.startedAt;
  const ttftMs = answer.firstTokenAt ? answer.firstTokenAt - ctx.startedAt : null;
  const attempts = [...routeAttempts, ...result.attempts];
  const served = { backend: result.backend?.config.id ?? null, model: result.backend?.config.model ?? null };
  const common = { routeReason, attempts, latencyMs, intent: answer.intent, confidence: answer.confidence, ...served };

  if (result.status === "ok") return { ...common, outcome: "success", httpStatus: 200, ttftMs };

  if (result.status === "stopped") {
    const lowConfidence = result.stop.kind === "low_confidence";
    sink.emit("refusal", {
      reason: result.stop.kind,
      detail: result.stop.detail,
      message: lowConfidence ? LOW_CONFIDENCE_MESSAGE : OUT_OF_SCOPE_MESSAGE,
      intent: answer.intent,
      confidence: answer.confidence,
    });
    return { ...common, outcome: lowConfidence ? "refused_low_confidence" : "refused_out_of_scope", httpStatus: 200 };
  }

  const failure = failureOf(result.error, result.committed);
  const message =
    failure.code === "all_backends_failed" ? "All model backends failed or returned unusable output." : failure.message;
  sink.emit("error", { code: failure.code, message, partial: result.committed });
  return {
    ...common,
    outcome: failure.outcome,
    httpStatus: failure.httpStatus,
    ttftMs,
    errorCode: failure.code,
    errorMessage: result.error.message + (answer.chars ? ` (after ${answer.chars} chars streamed)` : ""),
  };
}
