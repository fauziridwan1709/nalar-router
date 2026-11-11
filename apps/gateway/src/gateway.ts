/**
 * Composition root: builds every adapter once at boot (and in tests) and wires them into the
 * use cases' AppDeps contract. This is the only module that knows every layer.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BackendConfig, Config } from "./config.js";
import { openDb, type DB, type SeedTenant, type SeedUser, DEMO_TENANTS, DEMO_USERS } from "./infrastructure/db/db.js";
import type { Backend } from "./application/ports/backend.js";
import { OpenAICompatBackend } from "./infrastructure/backends/openaiCompat.js";
import { MockBackend } from "./infrastructure/backends/mock.js";
import { ChaosRegistry, withChaos } from "./infrastructure/backends/chaos.js";
import { CircuitBreaker } from "./domain/routing/breaker.js";
import { Bm25Index, type KbEntry } from "./domain/support/retrieval.js";
import { HealthMonitor } from "./infrastructure/health.js";
import { sqliteQuotaStore } from "./infrastructure/db/quota.js";
import { sqliteMeteringStore } from "./infrastructure/db/metering.js";
import type { AppDeps } from "./application/deps.js";

export interface Gateway extends AppDeps {
  config: Config;
  db: DB;
  backends: Backend[];
  breaker: CircuitBreaker;
  chaos: ChaosRegistry;
  kb: Bm25Index;
  intents: string[];
  /** online/offline probes; started by index.ts, not in tests */
  health: HealthMonitor;
  /** process start, used as `created` in /v1/models */
  startedAt: number;
}

export function buildBackend(cfg: BackendConfig): Backend {
  return cfg.kind === "mock" ? new MockBackend(cfg) : new OpenAICompatBackend(cfg);
}

/** demo accounts only in demo mode; a real deployment bootstraps one operator from env vars */
export function consoleUsers(config: Config): SeedUser[] {
  const users = config.demoMode ? [...DEMO_USERS] : [];
  const b = config.auth.bootstrapOperator;
  if (b) users.push({ id: "usr_bootstrap_operator", tenantId: b.tenantId, email: b.email, name: "Operator", role: "operator", password: b.password });
  return users;
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
  const db = overrides.db ?? openDb(config.dbPath, overrides.seed ?? DEMO_TENANTS, consoleUsers(config));
  return {
    startedAt: Date.now(),
    config,
    db,
    quota: sqliteQuotaStore(db),
    metering: sqliteMeteringStore(db),
    backends,
    breaker: new CircuitBreaker(config.breaker.failureThreshold, config.breaker.openMs),
    chaos,
    kb: new Bm25Index(kbEntries),
    intents,
    health: new HealthMonitor(backends, config.health),
  };
}
