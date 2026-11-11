/** Pieces used by both the admin-token routes and the console routes. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Gateway } from "../gateway.js";

export const ChaosBody = z
  .object({
    failRate: z.number().min(0).max(1).optional(),
    mode: z.enum(["error", "hang", "garbage", "slow_first_token"]).optional(),
    addedLatencyMs: z.number().int().min(0).max(120_000).optional(),
  })
  .strict();

export function backendsFull(gw: Gateway) {
  return gw.backends.map((b) => ({
    id: b.config.id, tier: b.config.tier, model: b.config.model, enabled: b.config.enabled,
    location: b.config.location, health: gw.health.get(b.config.id),
    priceInPerM: b.config.priceInPerM, priceOutPerM: b.config.priceOutPerM,
    firstTokenTimeoutMs: b.config.firstTokenTimeoutMs, totalTimeoutMs: b.config.totalTimeoutMs,
    breaker: gw.breaker.snapshot(b.config.id), chaos: gw.chaos.get(b.config.id),
  }));
}

/** committed eval runs (tools/eval/results/*.json), summaries only: the per-case rows stay in the files */
export function listEvals(gw: Gateway) {
  const dir = gw.config.evalResultsDir;
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse() : [];
  return files.flatMap((f) => {
    try {
      const r = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
      return [{ file: f, stamp: r.stamp, judge: r.judge, n: r.n, configs: r.configs.map(({ rows: _rows, ...c }: any) => c) }];
    } catch {
      return [];
    }
  });
}
