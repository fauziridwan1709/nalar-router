/**
 * The one request path every model-calling capability goes through:
 * prepare → admit against quota (fail closed) → run → meter → respond.
 *
 * The public API (API key) and the console playground (signed-in user) both use it, so they
 * can't drift apart on quota or metering. It knows nothing about HTTP: the delivery layer
 * passes a CapabilityTransport (request id, client disconnect, JSON response) and sinks.
 */
import { randomUUID } from "node:crypto";
import { GatewayError } from "../entities/errors.js";
import type { AttemptRecord, FinalRecord } from "../entities/metering.js";
import type { Tenant } from "../entities/types.js";
import type { AppDeps } from "./deps.js";
import { CollectSink, type EventSink, type StreamingSink } from "./ports/sink.js";

/** what a capability run returns, before it is metered */
export interface RunResult extends FinalRecord {
  attempts: AttemptRecord[];
}

export interface RunContext {
  maxCompletionTokens: number;
  sink: EventSink;
  clientSignal: AbortSignal;
  startedAt: number;
}

/** a prepared capability request: what to admit and how to run it */
export interface CapabilitySpec {
  estimatedPromptTokens: number;
  requestedMaxTokens: number;
  promptVersion?: string;
  stream: boolean;
  /** the streaming sink for this capability's wire format */
  makeSink: () => StreamingSink;
  run: (ctx: RunContext) => Promise<RunResult>;
  /** the single JSON body for stream: false, built from the collected events */
  respondJson: (sink: CollectSink, done: DoneSummary) => unknown;
  /** PII types and counts found in the input (type:count,…), metered with the request; never values */
  pii?: string | null;
}

/** the delivery layer's side of a request */
export interface CapabilityTransport {
  /** called first, with the id every response and log line carries */
  begin(requestId: string): void;
  /** aborted when the client disconnects */
  clientSignal: AbortSignal;
  /** sends the single JSON response (stream: false), unless something was already sent */
  respond(status: number, body: unknown): void;
}

export interface DoneSummary {
  requestId: string;
  outcome: string;
  backend: string | null;
  model: string | null;
  fallbackUsed: boolean;
  attempts: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; source: string } | null;
  costUsd: number | null;
  latencyMs: number;
  ttftMs: number | null;
  intent: string | null;
  confidence: number | null;
  quota: { tokensRemaining: number; requestsRemaining: number } | null;
}

const newRequestId = () => `req_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

/**
 * Errors:
 * - `prepare` may throw a GatewayError (400 invalid_request, 403 model_not_allowed, 422 pii_detected,
 *   503 no_backend_available…). It is metered as a rejected request and rethrown for the
 *   delivery layer to send. Anything else becomes 500 internal_error, logged with the request id.
 * - admission throws 429 quota_exceeded or 503 quota_unavailable; no model is called.
 * - once admitted, the request always completes and is always metered: a crash inside `run`
 *   becomes outcome internal_error with an `error` event, never an unmetered request.
 */
export async function runCapability(
  deps: AppDeps,
  transport: CapabilityTransport,
  endpoint: string,
  who: { tenant: Tenant; credential: string },
  prepare: (tenant: Tenant) => CapabilitySpec,
): Promise<void> {
  const { tenant, credential } = who;
  const requestId = newRequestId();
  transport.begin(requestId);

  let spec: CapabilitySpec;
  try {
    spec = prepare(tenant);
  } catch (e) {
    const ge = e instanceof GatewayError ? e : new GatewayError(500, "internal_error", "Failed to prepare request.");
    if (!(e instanceof GatewayError)) console.error(`[${requestId}] prepare failed`, e);
    try {
      deps.metering.rejected(requestId, tenant.id, endpoint, ge.status, ge.code, ge.message, credential);
      if (ge.code === "pii_detected" && typeof ge.details?.pii === "string") deps.metering.pii(requestId, ge.details.pii);
    } catch (me) {
      console.error(`[${requestId}] metering a rejected request failed`, me); // must not mask the client error
    }
    if (ge.details?.pii) delete ge.details.pii; // the caller knows its own message; keep the response minimal
    throw ge;
  }

  // quota pre-authorisation: throws 429 / 503 and fails closed
  const admission = deps.quota.admit(tenant, {
    requestId,
    endpoint,
    estimatedPromptTokens: spec.estimatedPromptTokens,
    requestedMaxTokens: spec.requestedMaxTokens,
    promptVersion: spec.promptVersion,
    credential,
  });
  if (spec.pii) {
    try {
      deps.metering.pii(requestId, spec.pii);
    } catch (e) {
      console.error(`[${requestId}] pii metering failed`, e);
    }
  }

  const startedAt = Date.now();
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
    result = await spec.run({ maxCompletionTokens: admission.maxCompletionTokens, sink, clientSignal: transport.clientSignal, startedAt });
  } catch (e) {
    console.error(`[${requestId}] unhandled error in run`, e);
    result = {
      outcome: "internal_error", httpStatus: 500, attempts: [], latencyMs: Date.now() - startedAt,
      errorCode: "internal_error", errorMessage: String((e as Error)?.message ?? e),
    };
    sink.emit("error", { code: "internal_error", message: "Internal error." });
  }

  let summary;
  try {
    summary = deps.metering.finish(requestId, result, result.attempts);
  } catch (e) {
    console.error(`[${requestId}] metering write failed`, e);
  }
  let quotaAfter: DoneSummary["quota"] = null;
  try {
    const u = deps.quota.usage(tenant);
    quotaAfter = { tokensRemaining: u.tokensRemaining, requestsRemaining: u.requestsRemaining };
  } catch (e) {
    console.error(`[${requestId}] reading usage after the request failed`, e);
  }
  const done: DoneSummary = {
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
    quota: quotaAfter,
  };
  sink.emit("done", done);

  if (spec.stream) (sink as StreamingSink).end();
  else transport.respond(result.httpStatus === 499 ? 200 : result.httpStatus, spec.respondJson(sink as CollectSink, done));
}
