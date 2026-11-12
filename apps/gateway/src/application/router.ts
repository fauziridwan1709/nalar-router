/**
 * auto-smart's classification step. planRoute (domain) is pure and runs before admission; the
 * classifier is a model call, so it runs here, after admission, and is metered as an attempt
 * (outcome `classified`, seq 0) like any other call the tenant pays for.
 *
 * Any failure (no classifier backend, circuit open, HTTP error, timeout, unparseable reply) is
 * recorded and handed to planRoute, which then lets the heuristic decide. Classification never
 * fails a request.
 */
import { BackendError } from "../domain/errors.js";
import { buildClassifierMessages, parseVerdict, type ClassifierResult } from "../domain/routing/classifier.js";
import { planRoute, type RoutePlan, type RouteSignals } from "../domain/routing/policy.js";
import { estimateMessagesTokens, estimateTokens } from "../domain/tokens.js";
import type { Tenant } from "../domain/types.js";
import type { AppDeps } from "./deps.js";
import { costOf, type AttemptRecord } from "./executor.js";
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
  const s = deps.config.classifier;
  const messages = buildClassifierMessages(text);
  const started = Date.now();
  const ac = new AbortController();
  const onAbort = () => ac.abort(new BackendError("aborted", "client disconnected", false));
  ctx.clientSignal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(new BackendError("timeout_total", `no verdict within ${s.timeoutMs} ms`)), s.timeoutMs);

  let out = "";
  let reasoned = "";
  let usage: { promptTokens: number; completionTokens: number } | null = null;
  let error: string | null = null;
  let errKind: BackendError["kind"] | null = null;
  try {
    for await (const c of backend.stream({ messages, maxTokens: s.maxTokens, temperature: 0, signal: ac.signal })) {
      if (c.type === "text") out += c.text;
      else if (c.type === "reasoning") reasoned += c.text;
      else usage = { promptTokens: c.promptTokens, completionTokens: c.completionTokens };
    }
  } catch (e) {
    const reason = ac.signal.aborted ? ac.signal.reason : e;
    const be = reason instanceof BackendError ? reason : new BackendError("error", String((reason as Error)?.message ?? reason));
    error = be.message;
    errKind = be.kind;
  } finally {
    clearTimeout(timer);
    ctx.clientSignal.removeEventListener("abort", onAbort);
    if (!ac.signal.aborted) ac.abort();
  }

  const verdict = error ? null : parseVerdict(out);
  if (!error && !verdict) error = "unparseable verdict";
  const latencyMs = Date.now() - started;
  const u = usage as { promptTokens: number; completionTokens: number } | null;
  // same usage rules as the executor: provider-reported, else estimated, else none for an outright rejection
  const rejected = !u && (errKind === "http" || (errKind === "error" && !out && !reasoned));
  const promptTokens = u?.promptTokens ?? (rejected ? 0 : estimateMessagesTokens(messages));
  const completionTokens = u?.completionTokens ?? (rejected ? 0 : estimateTokens(out) + estimateTokens(reasoned));
  const attempt: AttemptRecord = {
    seq: 0, backend: backend.config.id, model: backend.config.model, startedAt: started,
    outcome: "classified", error: error ?? undefined, latencyMs,
    promptTokens, completionTokens,
    usageSource: u ? (backend.config.kind === "mock" ? "estimated" : "provider") : rejected ? "none" : "estimated",
    costUsd: costOf(backend, promptTokens, completionTokens),
  };
  // Provider errors count against the breaker, so a dead provider stops being asked. A timeout
  // doesn't: the classifier's budget is tighter than the backend's own, and tripping the breaker
  // over it would take the fast tier out of the answer chain.
  if (errKind === "error" || errKind === "http") deps.breaker.failure(backend.config.id, error!);
  const result: ClassifierResult = verdict
    ? { status: "ok", backend: backend.config.id, latencyMs, ...verdict }
    : { status: "failed", backend: backend.config.id, latencyMs, error: error! };
  return { result, attempt };
}
