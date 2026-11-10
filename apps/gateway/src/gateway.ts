/** Dependency container: everything a request handler needs, built once at boot (and in tests). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BackendConfig, Config } from "./config.js";
import { openDb, type DB, type SeedTenant, DEMO_TENANTS } from "./db.js";
import type { Backend } from "./backends/types.js";
import { OpenAICompatBackend } from "./backends/openaiCompat.js";
import { MockBackend } from "./backends/mock.js";
import { ChaosRegistry, withChaos } from "./backends/chaos.js";
import { CircuitBreaker } from "./router/breaker.js";
import { Bm25Index, type KbEntry } from "./support/retrieval.js";

export interface Gateway {
  config: Config;
  db: DB;
  backends: Backend[];
  breaker: CircuitBreaker;
  chaos: ChaosRegistry;
  kb: Bm25Index;
  intents: string[];
}

export function buildBackend(cfg: BackendConfig): Backend {
  return cfg.kind === "mock" ? new MockBackend(cfg) : new OpenAICompatBackend(cfg);
}

export function createGateway(
  config: Config,
  overrides: Partial<{ db: DB; backends: Backend[]; kbEntries: KbEntry[]; seed: SeedTenant[]; chaos: ChaosRegistry }> = {},
): Gateway {
  const chaos = overrides.chaos ?? new ChaosRegistry();
  const raw = overrides.backends ?? config.backends.map(buildBackend);
  const backends = raw.map((b) => withChaos(b, chaos));
  const kbEntries: KbEntry[] = overrides.kbEntries ?? JSON.parse(readFileSync(resolve(config.dataDir, "kb.json"), "utf8"));
  const intents = [...new Set(kbEntries.map((e) => e.intent))].sort();
  return {
    config,
    db: overrides.db ?? openDb(config.dbPath, overrides.seed ?? DEMO_TENANTS),
    backends,
    breaker: new CircuitBreaker(config.breaker.failureThreshold, config.breaker.openMs),
    chaos,
    kb: new Bm25Index(kbEntries),
    intents,
  };
}
