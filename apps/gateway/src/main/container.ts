/**
 * Composition root ("Main" in the clean architecture): builds every adapter once at boot (and in
 * tests) and wires them into the use cases' GatewayDeps contract. This is the only module that
 * knows every layer.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BackendConfig, Config } from "./config.js";
import { FailureLimiter } from "../entities/auth/failureLimiter.js";
import { CircuitBreaker } from "../entities/routing/breaker.js";
import { Bm25Index, type KbEntry } from "../entities/support/retrieval.js";
import type { DemoAccount, GatewayDeps } from "../use-cases/deps.js";
import type { Backend } from "../use-cases/ports/backend.js";
import { scryptPasswords } from "../interface-adapters/gateways/crypto/passwords.js";
import { fileEvalResults } from "../interface-adapters/gateways/files/evalResults.js";
import { ChaosRegistry, withChaos } from "../interface-adapters/gateways/llm/chaos.js";
import { HealthMonitor } from "../interface-adapters/gateways/llm/health.js";
import { MockBackend } from "../interface-adapters/gateways/llm/mock.js";
import { OpenAICompatBackend } from "../interface-adapters/gateways/llm/openaiCompat.js";
import { sqliteApiKeyRepository } from "../interface-adapters/gateways/sqlite/apiKeys.js";
import { sqliteMeteringStore } from "../interface-adapters/gateways/sqlite/metering.js";
import { sqliteQuotaStore } from "../interface-adapters/gateways/sqlite/quota.js";
import { sqliteReporting } from "../interface-adapters/gateways/sqlite/reporting.js";
import { sqliteAuditLog, sqliteSessionStore, sqliteUserDirectory } from "../interface-adapters/gateways/sqlite/sessions.js";
import { sqliteTenantRepository } from "../interface-adapters/gateways/sqlite/tenants.js";
import { DEMO_TENANTS, DEMO_USERS, openDb, type DB, type SeedTenant, type SeedUser } from "../frameworks/sqlite/db.js";

/** the use cases' dependencies, plus what only the process (index.ts) and tests touch */
export interface Gateway extends GatewayDeps {
  config: Config;
  db: DB;
  chaos: ChaosRegistry;
  /** online/offline probes; started by index.ts, not in tests */
  health: HealthMonitor;
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

const demoAccounts = (config: Config): DemoAccount[] =>
  config.demoMode
    ? DEMO_USERS.map((u) => ({ email: u.email, role: u.role, tenantId: u.tenantId, password: u.passwordFromEnv ? null : u.password }))
    : [];

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
  const { auth } = config;
  return {
    startedAt: Date.now(),
    config,
    db,
    quota: sqliteQuotaStore(db),
    metering: sqliteMeteringStore(db),
    tenants: sqliteTenantRepository(db),
    apiKeys: sqliteApiKeyRepository(db),
    users: sqliteUserDirectory(db),
    sessions: sqliteSessionStore(db),
    audit: sqliteAuditLog(db),
    reporting: sqliteReporting(db),
    passwords: scryptPasswords,
    evals: fileEvalResults(config.evalResultsDir),
    signInLimits: {
      perAccount: new FailureLimiter(auth.maxFailuresPerAccount, auth.failureWindowMs),
      perIp: new FailureLimiter(auth.maxFailuresPerIp, auth.failureWindowMs),
    },
    demoAccounts: demoAccounts(config),
    backends,
    breaker: new CircuitBreaker(config.breaker.failureThreshold, config.breaker.openMs),
    chaos,
    kb: new Bm25Index(kbEntries),
    intents,
    health: new HealthMonitor(backends, config.health),
  };
}
