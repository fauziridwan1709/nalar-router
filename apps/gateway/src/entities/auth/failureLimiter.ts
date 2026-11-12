/**
 * Fixed-window failure counter for sign-in. In memory: fine for one instance; with several
 * instances it would move to the shared store. Counts failures only, so a user who signs in
 * correctly is never slowed down, and a success clears that account's counter.
 */
export class FailureLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  /** seconds until the key may try again, or 0 if it is allowed now */
  blockedFor(key: string, now = Date.now()) {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) return 0;
    return h.n >= this.max ? Math.ceil((h.resetAt - now) / 1000) : 0;
  }

  fail(key: string, now = Date.now()) {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) this.hits.set(key, { n: 1, resetAt: now + this.windowMs });
    else h.n++;
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }

  clear(key: string) {
    this.hits.delete(key);
  }
}
