/**
 * Fault injection, applicable to ANY backend (real or mock), controlled at runtime via
 * the admin API / console. This is how fallback, timeouts and bad-output handling are
 * demonstrated and tested deterministically.
 */
import { BackendError } from "../../../entities/errors.js";
import type { Backend, BackendRequest, StreamChunk } from "../../../use-cases/ports/backend.js";

import type { ChaosMode, ChaosSettings, FaultInjection } from "../../../use-cases/ports/operations.js";
export type { ChaosMode, ChaosSettings };

export const NO_CHAOS: ChaosSettings = { failRate: 0, mode: "error", addedLatencyMs: 0 };

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class ChaosRegistry implements FaultInjection {
  private settings = new Map<string, ChaosSettings>();
  constructor(private random: () => number = Math.random) {}
  get(id: string): ChaosSettings {
    return this.settings.get(id) ?? NO_CHAOS;
  }
  set(id: string, s: Partial<ChaosSettings>) {
    const next = { ...this.get(id), ...s };
    next.failRate = Math.min(1, Math.max(0, Number(next.failRate) || 0));
    next.addedLatencyMs = Math.min(120_000, Math.max(0, Number(next.addedLatencyMs) || 0));
    this.settings.set(id, next);
    return next;
  }
  all() {
    return Object.fromEntries(this.settings);
  }
  clear() {
    this.settings.clear();
  }
  roll(id: string) {
    const s = this.get(id);
    return s.failRate > 0 && this.random() < s.failRate;
  }
}

export function withChaos(inner: Backend, chaos: ChaosRegistry): Backend {
  return {
    config: inner.config,
    async *stream(req: BackendRequest): AsyncIterable<StreamChunk> {
      const s = chaos.get(inner.config.id);
      await abortableSleep(s.addedLatencyMs, req.signal);
      if (chaos.roll(inner.config.id)) {
        switch (s.mode) {
          case "error":
            throw new BackendError("error", "chaos: injected backend failure (simulated 503)", true, 503);
          case "hang":
          case "slow_first_token":
            // never produce a token; the executor's first-token timeout must catch this
            await abortableSleep(10 * 60_000, req.signal);
            return;
          case "garbage":
            yield { type: "text", text: "Sure!! <<<%%% INTENT ??? lorem ipsum {not json" };
            yield { type: "usage", promptTokens: 50, completionTokens: 12 };
            return;
        }
      }
      yield* inner.stream(req);
    },
  };
}
