/**
 * auto-smart's classification step. planRoute (domain) is pure and runs before admission; the
 * classifier is a model call, so it runs here, after admission, and is metered as an attempt
 * (outcome `classified`, seq 0) like any other call the tenant pays for.
 *
 * Any failure (no classifier backend, circuit open, HTTP error, timeout, unparseable reply) is
 * recorded and handed to planRoute, which then lets the heuristic decide. Classification never
 * fails a request.
 */
import { BackendError } from "../entities/errors.js";
import { buildClassifierMessages, parseVerdict, type ClassifierResult } from "../entities/routing/classifier.js";
import { planRoute, type RoutePlan, type RouteSignals } from "../entities/routing/policy.js";
import { attemptUsage } from "../entities/metering.js";
import type { Tenant } from "../entities/types.js";
import type { AppDeps } from "./deps.js";
import { costOf, failureCause, type AttemptRecord } from "./executor.js";
import type { Backend } from "./ports/backend.js";
import type { EventSink } from "./ports/sink.js";

export interface ResolvedRoute {
  plan: RoutePlan<Backend>;
  /** the classification attempt, if one was made; meter it with the request */
  attempts: AttemptRecord[];
}

function classifierBackend(deps: AppDeps): Backend | undefined {
  const usable = (b: Backend) => b.config.enabled && !deps.breaker.isOpen(b.config.id);
  const byId = deps.backends.find((b) => b.config.id === deps.config.classifier.backendId);
  if (byId && usable(byId)) return byId;
  return deps.backends.find((b) => b.config.tier === "fast" && usable(b));
}

/** Runs the classifier and re-plans; a plan that doesn't need it is returned unchanged. */
export async function resolveRoute(
  deps: AppDeps,
  tenant: Tenant,
  signals: RouteSignals,
  plan: RoutePlan<Backend>,
  ctx: { sink: EventSink; clientSignal: AbortSignal },
): Promise<ResolvedRoute> {
  if (!plan.needsClassifier) return { plan, attempts: [] };
  const { result, attempt } = await classify(deps, signals.text ?? "", ctx);
  ctx.sink.emit("step", {
    name: "route_classified",
    detail:
      result.status === "ok"
        ? `${result.backend} says ${result.label} (confidence ${result.confidence}) in ${result.latencyMs} ms`
        : `classifier failed: ${result.error}; the heuristic decides`,
  });
  const next = planRoute(deps.backends, tenant, { ...signals, classifier: result }, deps.config.routing);
  return { plan: next, attempts: attempt ? [attempt] : [] };
}

async function classify(
  deps: AppDeps,
  text: string,
  ctx: { clientSignal: AbortSignal },
): Promise<{ result: ClassifierResult; attempt: AttemptRecord | null }> {
  const backend = classifierBackend(deps);
  if (!backend) return { result: { status: "failed", error: "no classifier backend available" }, attempt: null };
  const settings = deps.config.classifier;
  const messages = buildClassifierMessages(text);
  const started = Date.now();
  const abort = new AbortController();
  const onAbort = () => abort.abort(new BackendError("aborted", "client disconnected", false));
  ctx.clientSignal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => abort.abort(new BackendError("timeout_total", `no verdict within ${settings.timeoutMs} ms`)),
    settings.timeoutMs,
  );

  let out = "";
  let reasoned = "";
  let reported = null as { promptTokens: number; completionTokens: number } | null;
  let failure: BackendError | null = null;
  try {
    for await (const chunk of backend.stream({
      messages,
      maxTokens: settings.maxTokens,
      temperature: 0,
      signal: abort.signal,
    })) {
      if (chunk.type === "text") out += chunk.text;
      else if (chunk.type === "reasoning") reasoned += chunk.text;
      else reported = { promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens };
    }
  } catch (e) {
    failure = failureCause(e, abort.signal);
  } finally {
    clearTimeout(timer);
    ctx.clientSignal.removeEventListener("abort", onAbort);
    if (!abort.signal.aborted) abort.abort();
  }

  const verdict = failure ? null : parseVerdict(out);
  const error = failure?.message ?? (verdict ? null : "unparseable verdict");
  const latencyMs = Date.now() - started;
  // the same usage rules as the executor
  const usage = attemptUsage({
    reported,
    isMock: backend.config.kind === "mock",
    rejected: failure?.kind === "http" || (failure?.kind === "error" && !out && !reasoned),
    promptText: messages,
    produced: out,
    reasoned,
  });
  const attempt: AttemptRecord = {
    seq: 0,
    backend: backend.config.id,
    model: backend.config.model,
    startedAt: started,
    outcome: "classified",
    error: error ?? undefined,
    latencyMs,
    ...usage,
    costUsd: costOf(backend, usage.promptTokens, usage.completionTokens),
  };
  // Provider errors count against the breaker, so a dead provider stops being asked. A timeout
  // doesn't: the classifier's budget is tighter than the backend's own, and tripping the breaker
  // over it would take the fast tier out of the answer chain.
  if (failure?.kind === "error" || failure?.kind === "http") deps.breaker.failure(backend.config.id, failure.message);
  const result: ClassifierResult = verdict
    ? { status: "ok", backend: backend.config.id, latencyMs, ...verdict }
    : { status: "failed", backend: backend.config.id, latencyMs, error: error! };
  return { result, attempt };
}
