/**
 * Runs a request down the route chain with timeouts, fallback and per-attempt metering.
 *
 * Contract with the capability (`consume`):
 *  - `consume` reads the backend's text stream.
 *  - Before it calls `ctx.commit()` (i.e. before the first byte goes to the client),
 *    any failure – HTTP error, first-token timeout, unusable output – falls through to
 *    the next backend.
 *  - After commit, failures end the request (we never splice two models' outputs into
 *    one answer); the client gets an `error` event and the outcome is recorded.
 */
import type { Backend, BackendRequest, ChatMessage } from "./ports/backend.js";
import { BackendError } from "../entities/errors.js";
import { estimateMessagesTokens, estimateTokens } from "../entities/tokens.js";
import type { CircuitBreaker } from "../entities/routing/breaker.js";
import type { AttemptOutcome, AttemptRecord } from "../entities/metering.js";
export type { AttemptOutcome, AttemptRecord };

export interface ConsumeContext {
  backend: Backend;
  attemptSeq: number;
  /** mark the point of no return (first byte sent to the client) */
  commit(): void;
}

/** Thrown by `consume` to stop WITHOUT falling back (e.g. low-confidence refusal). */
export class StopRequest extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

export interface ExecuteOptions {
  chain: Backend[];
  breaker: CircuitBreaker;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  sampling?: BackendRequest["sampling"];
  hints?: BackendRequest["hints"];
  includeReasoning?: boolean;
  /** reasoning is diagnostic only: it is forwarded as-is, never parsed, and is not the commit point */
  onReasoning?: (info: { seq: number; backend: string; text: string }) => void;
  clientSignal: AbortSignal;
  consume: (text: AsyncIterable<string>, ctx: ConsumeContext) => Promise<void>;
  onAttemptStart?: (info: { seq: number; backend: string; model: string }) => void;
  onAttemptEnd?: (a: AttemptRecord) => void;
  now?: () => number;
}

export type ExecuteResult =
  | { status: "ok"; backend: Backend; attempts: AttemptRecord[] }
  | { status: "stopped"; backend: Backend; attempts: AttemptRecord[]; reason: string }
  | { status: "failed"; attempts: AttemptRecord[]; committed: boolean; error: BackendError; backend?: Backend };

export function costOf(b: Backend, promptTokens: number, completionTokens: number) {
  return (promptTokens * b.config.priceInPerM + completionTokens * b.config.priceOutPerM) / 1_000_000;
}

export async function executeWithFallback(o: ExecuteOptions): Promise<ExecuteResult> {
  const now = o.now ?? Date.now;
  const attempts: AttemptRecord[] = [];
  let lastErr: BackendError = new BackendError("error", "no backend attempted", false);
  let seq = 0;

  for (const backend of o.chain) {
    const cfg = backend.config;
    seq++;
    if (o.clientSignal.aborted) {
      return { status: "failed", attempts, committed: false, error: new BackendError("aborted", "client disconnected", false) };
    }
    if (o.breaker.isOpen(cfg.id)) {
      const rec: AttemptRecord = {
        seq, backend: cfg.id, model: cfg.model, startedAt: now(), outcome: "skipped_circuit_open",
        error: "circuit breaker open after repeated failures", latencyMs: 0,
        promptTokens: 0, completionTokens: 0, usageSource: "none", costUsd: 0,
      };
      attempts.push(rec);
      o.onAttemptEnd?.(rec);
      continue;
    }

    o.onAttemptStart?.({ seq, backend: cfg.id, model: cfg.model });
    const started = now();
    const ac = new AbortController();
    const onClientAbort = () => ac.abort(new BackendError("aborted", "client disconnected", false));
    o.clientSignal.addEventListener("abort", onClientAbort, { once: true });
    const ttftTimer = setTimeout(
      () => ac.abort(new BackendError("timeout_first_token", `no first token within ${cfg.firstTokenTimeoutMs} ms`)),
      cfg.firstTokenTimeoutMs,
    );
    const totalTimer = setTimeout(
      () => ac.abort(new BackendError("timeout_total", `exceeded total timeout ${cfg.totalTimeoutMs} ms`)),
      cfg.totalTimeoutMs,
    );

    let ttft: number | undefined;
    let produced = "";
    let reasoned = "";
    let usage: { promptTokens: number; completionTokens: number } | null = null;
    let committed = false;
    let requestSent = false;

    async function* text(): AsyncIterable<string> {
      requestSent = true;
      for await (const c of backend.stream({
        messages: o.messages, maxTokens: o.maxTokens, temperature: o.temperature, sampling: o.sampling, hints: o.hints,
        includeReasoning: o.includeReasoning, signal: ac.signal,
      })) {
        if (c.type === "reasoning") {
          // a thinking model is alive even before its first answer token: stop the first-token timer
          clearTimeout(ttftTimer);
          reasoned += c.text;
          o.onReasoning?.({ seq, backend: cfg.id, text: c.text });
        } else if (c.type === "text") {
          if (ttft === undefined) {
            ttft = now() - started;
            clearTimeout(ttftTimer);
          }
          produced += c.text;
          yield c.text;
        } else {
          usage = { promptTokens: c.promptTokens, completionTokens: c.completionTokens };
        }
      }
    }

    let outcome: AttemptOutcome = "ok";
    let err: BackendError | null = null;
    let stopReason: string | null = null;
    try {
      await o.consume(text(), { backend, attemptSeq: seq, commit: () => (committed = true) });
    } catch (e) {
      if (e instanceof StopRequest) {
        outcome = "refused";
        stopReason = e.reason;
      } else {
        // an abort surfaces as a generic AbortError; the real cause is the abort reason
        const reason = ac.signal.aborted ? ac.signal.reason : e;
        err =
          reason instanceof BackendError
            ? reason
            : new BackendError("error", (reason as Error)?.message ?? String(reason));
        outcome = err.kind === "http" ? "error" : (err.kind as AttemptOutcome);
      }
    } finally {
      clearTimeout(ttftTimer);
      clearTimeout(totalTimer);
      o.clientSignal.removeEventListener("abort", onClientAbort);
      if (!ac.signal.aborted) ac.abort(); // stop reading the provider stream if consume bailed early
    }

    // usage: provider-reported if we got it; otherwise estimate. A request rejected at the
    // HTTP layer (no tokens, non-2xx) is assumed unbilled.
    let promptTokens = 0;
    let completionTokens = 0;
    let usageSource: AttemptRecord["usageSource"] = "none";
    const u = usage as { promptTokens: number; completionTokens: number } | null;
    if (u) {
      promptTokens = u.promptTokens;
      completionTokens = u.completionTokens;
      usageSource = cfg.kind === "mock" ? "estimated" : "provider";
    } else if (requestSent && !(err?.kind === "http" || (err?.kind === "error" && !produced && !reasoned))) {
      promptTokens = estimateMessagesTokens(o.messages);
      completionTokens = estimateTokens(produced) + estimateTokens(reasoned); // reasoning tokens are billed too
      usageSource = "estimated";
    }
    const rec: AttemptRecord = {
      seq, backend: cfg.id, model: cfg.model, startedAt: started, outcome,
      error: err?.message ?? stopReason ?? undefined,
      latencyMs: now() - started, ttftMs: ttft,
      promptTokens, completionTokens, usageSource,
      costUsd: costOf(backend, promptTokens, completionTokens),
    };
    attempts.push(rec);
    o.onAttemptEnd?.(rec);

    if (outcome === "ok") {
      o.breaker.success(cfg.id);
      return { status: "ok", backend, attempts };
    }
    if (outcome === "refused") {
      o.breaker.success(cfg.id);
      return { status: "stopped", backend, attempts, reason: stopReason! };
    }
    // infra failures count against the breaker; bad output and client aborts do not
    if (outcome === "error" || outcome === "timeout_first_token" || outcome === "timeout_total") {
      o.breaker.failure(cfg.id, err!.message);
    }
    lastErr = err!;
    if (committed || err!.kind === "aborted" || !err!.retryable) {
      return { status: "failed", attempts, committed, error: err!, backend };
    }
  }
  return { status: "failed", attempts, committed: false, error: lastErr };
}
