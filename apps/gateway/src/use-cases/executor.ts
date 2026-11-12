/**
 * Runs a request down the route chain with timeouts, fallback and per-attempt metering.
 *
 * Contract with the capability (`consume`):
 *  - `consume` reads the backend's text stream.
 *  - Before it calls `ctx.commit()` (the first byte goes to the client), any failure (HTTP error,
 *    first-token timeout, unusable output) falls through to the next backend.
 *  - After commit, failures end the request: two models' outputs are never spliced into one
 *    answer. The client gets an `error` event and the outcome is recorded.
 *  - `consume` may throw `StopRequest` to end the request on purpose (a refusal): no fallback,
 *    and the circuit breaker doesn't count it.
 */
import type { Backend, BackendRequest, ChatMessage } from "./ports/backend.js";
import { BackendError } from "../entities/errors.js";
import type { CircuitBreaker } from "../entities/routing/breaker.js";
import { attemptUsage, type AttemptOutcome, type AttemptRecord } from "../entities/metering.js";
export type { AttemptOutcome, AttemptRecord };

export interface ConsumeContext {
  backend: Backend;
  attemptSeq: number;
  /** mark the point of no return (first byte sent to the client) */
  commit(): void;
}

/** why a capability stopped a request on purpose */
export type StopKind = "out_of_scope" | "low_confidence";

/** Thrown by `consume` to stop WITHOUT falling back (a refusal). */
export class StopRequest extends Error {
  constructor(
    public readonly kind: StopKind,
    public readonly detail: string,
  ) {
    super(detail);
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
  onAttemptEnd?: (attempt: AttemptRecord) => void;
  now?: () => number;
}

export type ExecuteResult =
  | { status: "ok"; backend: Backend; attempts: AttemptRecord[] }
  | { status: "stopped"; backend: Backend; attempts: AttemptRecord[]; stop: StopRequest }
  | { status: "failed"; attempts: AttemptRecord[]; committed: boolean; error: BackendError; backend?: Backend };

export function costOf(backend: Backend, promptTokens: number, completionTokens: number) {
  return (promptTokens * backend.config.priceInPerM + completionTokens * backend.config.priceOutPerM) / 1_000_000;
}

/** the real cause of a failure: an abort surfaces as a generic AbortError, its reason says why */
export function failureCause(error: unknown, signal: AbortSignal): BackendError {
  const reason = signal.aborted ? signal.reason : error;
  return reason instanceof BackendError
    ? reason
    : new BackendError("error", (reason as Error)?.message ?? String(reason));
}

/** infra failures count against the circuit breaker; bad output, refusals and client aborts do not */
const COUNTS_AGAINST_BREAKER: ReadonlySet<AttemptOutcome> = new Set(["error", "timeout_first_token", "timeout_total"]);

export async function executeWithFallback(opts: ExecuteOptions): Promise<ExecuteResult> {
  const now = opts.now ?? Date.now;
  const attempts: AttemptRecord[] = [];
  let lastError: BackendError = new BackendError("error", "no backend attempted", false);
  let seq = 0;

  for (const backend of opts.chain) {
    const cfg = backend.config;
    seq++;
    if (opts.clientSignal.aborted) {
      return {
        status: "failed",
        attempts,
        committed: false,
        error: new BackendError("aborted", "client disconnected", false),
      };
    }
    if (opts.breaker.isOpen(cfg.id)) {
      const skipped: AttemptRecord = {
        seq,
        backend: cfg.id,
        model: cfg.model,
        startedAt: now(),
        outcome: "skipped_circuit_open",
        error: "circuit breaker open after repeated failures",
        latencyMs: 0,
        promptTokens: 0,
        completionTokens: 0,
        usageSource: "none",
        costUsd: 0,
      };
      attempts.push(skipped);
      opts.onAttemptEnd?.(skipped);
      continue;
    }

    const attempt = await runAttempt(backend, seq, opts, now);
    attempts.push(attempt.record);
    opts.onAttemptEnd?.(attempt.record);

    if (attempt.record.outcome === "ok") {
      opts.breaker.success(cfg.id);
      return { status: "ok", backend, attempts };
    }
    if (attempt.stop) {
      opts.breaker.success(cfg.id);
      return { status: "stopped", backend, attempts, stop: attempt.stop };
    }
    const error = attempt.error!;
    if (COUNTS_AGAINST_BREAKER.has(attempt.record.outcome)) opts.breaker.failure(cfg.id, error.message);
    lastError = error;
    if (attempt.committed || error.kind === "aborted" || !error.retryable) {
      return { status: "failed", attempts, committed: attempt.committed, error, backend };
    }
  }
  return { status: "failed", attempts, committed: false, error: lastError };
}

/** one call to one backend: timers, the stream handed to `consume`, and the attempt's metering */
async function runAttempt(backend: Backend, seq: number, opts: ExecuteOptions, now: () => number) {
  const cfg = backend.config;
  opts.onAttemptStart?.({ seq, backend: cfg.id, model: cfg.model });
  const started = now();
  const abort = new AbortController();
  const onClientAbort = () => abort.abort(new BackendError("aborted", "client disconnected", false));
  opts.clientSignal.addEventListener("abort", onClientAbort, { once: true });
  const firstTokenTimer = setTimeout(
    () => abort.abort(new BackendError("timeout_first_token", `no first token within ${cfg.firstTokenTimeoutMs} ms`)),
    cfg.firstTokenTimeoutMs,
  );
  const totalTimer = setTimeout(
    () => abort.abort(new BackendError("timeout_total", `exceeded total timeout ${cfg.totalTimeoutMs} ms`)),
    cfg.totalTimeoutMs,
  );

  let ttftMs: number | undefined;
  let produced = "";
  let reasoned = "";
  let reported = null as { promptTokens: number; completionTokens: number } | null;
  let committed = false;
  let requestSent = false;

  async function* text(): AsyncIterable<string> {
    requestSent = true;
    const request: BackendRequest = {
      messages: opts.messages,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      sampling: opts.sampling,
      hints: opts.hints,
      includeReasoning: opts.includeReasoning,
      signal: abort.signal,
    };
    for await (const chunk of backend.stream(request)) {
      if (chunk.type === "reasoning") {
        // a thinking model is alive even before its first answer token: stop the first-token timer
        clearTimeout(firstTokenTimer);
        reasoned += chunk.text;
        opts.onReasoning?.({ seq, backend: cfg.id, text: chunk.text });
      } else if (chunk.type === "text") {
        if (ttftMs === undefined) {
          ttftMs = now() - started;
          clearTimeout(firstTokenTimer);
        }
        produced += chunk.text;
        yield chunk.text;
      } else {
        reported = { promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens };
      }
    }
  }

  let outcome: AttemptOutcome = "ok";
  let error: BackendError | null = null;
  let stop: StopRequest | null = null;
  try {
    await opts.consume(text(), {
      backend,
      attemptSeq: seq,
      commit: () => {
        committed = true;
      },
    });
  } catch (e) {
    if (e instanceof StopRequest) {
      outcome = "refused";
      stop = e;
    } else {
      error = failureCause(e, abort.signal);
      outcome = error.kind === "http" ? "error" : (error.kind as AttemptOutcome);
    }
  } finally {
    clearTimeout(firstTokenTimer);
    clearTimeout(totalTimer);
    opts.clientSignal.removeEventListener("abort", onClientAbort);
    if (!abort.signal.aborted) abort.abort(); // stop reading the provider stream if consume bailed early
  }

  const usage = attemptUsage({
    reported,
    isMock: cfg.kind === "mock",
    rejected: !requestSent || error?.kind === "http" || (error?.kind === "error" && !produced && !reasoned),
    promptText: opts.messages,
    produced,
    reasoned,
  });
  const record: AttemptRecord = {
    seq,
    backend: cfg.id,
    model: cfg.model,
    startedAt: started,
    outcome,
    error: error?.message ?? stop?.detail ?? undefined,
    latencyMs: now() - started,
    ttftMs,
    ...usage,
    costUsd: costOf(backend, usage.promptTokens, usage.completionTokens),
  };
  return { record, error, stop, committed };
}
