/**
 * Per-backend circuit breaker. After N consecutive infrastructure failures
 * (errors / timeouts, NOT bad model output) the backend is skipped for `openMs`,
 * so a dead provider costs one timeout, not one timeout per request.
 * After `openMs` one trial request is let through (half-open).
 */
export interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
  lastError: string | null;
}

export class CircuitBreaker {
  private states = new Map<string, BreakerState>();
  constructor(
    private failureThreshold: number,
    private openMs: number,
    private now: () => number = Date.now,
  ) {}

  private s(id: string): BreakerState {
    let st = this.states.get(id);
    if (!st) {
      st = { consecutiveFailures: 0, openedAt: null, lastError: null };
      this.states.set(id, st);
    }
    return st;
  }

  /** true = skip this backend */
  isOpen(id: string): boolean {
    const st = this.s(id);
    if (st.openedAt === null) return false;
    if (this.now() - st.openedAt >= this.openMs) {
      // half-open: allow a trial; a failure re-opens immediately
      st.openedAt = null;
      st.consecutiveFailures = this.failureThreshold - 1;
      return false;
    }
    return true;
  }

  success(id: string) {
    const st = this.s(id);
    st.consecutiveFailures = 0;
    st.openedAt = null;
  }

  failure(id: string, error: string) {
    const st = this.s(id);
    st.consecutiveFailures++;
    st.lastError = error;
    if (st.consecutiveFailures >= this.failureThreshold) st.openedAt = this.now();
  }

  snapshot(id: string) {
    const st = this.s(id);
    const open = st.openedAt !== null && this.now() - st.openedAt < this.openMs;
    return {
      state: open ? "open" : st.consecutiveFailures > 0 ? "degraded" : "closed",
      consecutiveFailures: st.consecutiveFailures,
      reopensInMs: open ? this.openMs - (this.now() - st.openedAt!) : 0,
      lastError: st.lastError,
    };
  }

  reset() {
    this.states.clear();
  }
}
