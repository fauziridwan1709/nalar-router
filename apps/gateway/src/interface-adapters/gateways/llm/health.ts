/**
 * Backend availability for the online/offline label.
 *
 *  - `disabled`: not configured on this host (e.g. the local MLX model on the cloud deployment).
 *    Shown as offline with that reason, never routed to.
 *  - `online` / `offline`: result of a cheap active probe (GET {baseUrl}/models) every
 *    `health.intervalMs`. The built-in mock is always online.
 *  - The circuit breaker state is reported next to it. A backend can answer the probe and still be
 *    failing real requests; that's what the breaker is for.
 *
 * The probe is informational. Routing doesn't depend on it: the breaker and fallback already handle
 * dead backends, at the cost of one fast failure (connection refused) instead of zero.
 */
import type { Backend } from "../../../use-cases/ports/backend.js";

import type { Availability, BackendHealth, HealthReader } from "../../../use-cases/ports/operations.js";
export type { Availability, BackendHealth };

export class HealthMonitor implements HealthReader {
  private state = new Map<string, BackendHealth>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private backends: Backend[],
    private opts: { intervalMs: number; timeoutMs: number },
  ) {
    for (const b of backends) {
      const c = b.config;
      this.state.set(c.id, {
        id: c.id,
        location: c.location,
        availability: !c.enabled ? "disabled" : c.kind === "mock" ? "online" : "unknown",
        label: c.enabled && c.kind === "mock" ? "online" : "offline",
        reason: !c.enabled
          ? c.location === "local"
            ? "runs on a local machine; not configured on this deployment"
            : "not configured (missing credentials)"
          : c.kind === "mock"
            ? "built in, always available"
            : "not checked yet",
        checkedAt: null,
        probeLatencyMs: null,
      });
    }
  }

  start() {
    // probe() catches its own failures; the catch here only guards against a bug turning into an
    // unhandled rejection, which main/index.ts treats as fatal
    const run = () => void this.probeAll().catch((e) => console.error("health probe failed", e));
    run();
    this.timer = setInterval(run, this.opts.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  get(id: string): BackendHealth | undefined {
    return this.state.get(id);
  }

  all(): BackendHealth[] {
    return [...this.state.values()];
  }

  async probeAll() {
    await Promise.all(
      this.backends.filter((b) => b.config.enabled && b.config.kind === "openai-compatible").map((b) => this.probe(b)),
    );
  }

  private async probe(b: Backend) {
    const c = b.config;
    const started = Date.now();
    let ok = false;
    let reason = "";
    try {
      const res = await fetch(`${c.baseUrl}/models`, {
        headers: { authorization: `Bearer ${c.apiKey ?? ""}` },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      ok = res.ok;
      reason = ok ? "reachable" : `probe returned HTTP ${res.status}`;
      await res.body?.cancel();
    } catch (e) {
      reason = `unreachable: ${(e as Error).message.slice(0, 120)}`;
    }
    this.state.set(c.id, {
      ...this.state.get(c.id)!,
      availability: ok ? "online" : "offline",
      label: ok ? "online" : "offline",
      reason,
      checkedAt: Date.now(),
      probeLatencyMs: Date.now() - started,
    });
  }
}
