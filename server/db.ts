import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Tier } from "./config.js";

export type DB = DatabaseSync;

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  allowed_tiers TEXT NOT NULL,          -- JSON array of Tier
  token_quota INTEGER NOT NULL,         -- per calendar month (UTC)
  request_quota INTEGER NOT NULL,       -- per calendar month (UTC)
  quota_reset_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- one row per gateway request (after auth). Source of truth for metering AND quota usage.
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  endpoint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT NOT NULL,                -- in_progress|success|refused_*|failed_all_backends|quota_exceeded|...
  http_status INTEGER,
  backend TEXT,                         -- backend that produced the final answer
  model TEXT,
  route_reason TEXT,                    -- JSON: rule, chain, signals
  fallback_used INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,      -- summed over all attempts (we pay for failed ones too)
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  usage_source TEXT,                    -- provider|estimated|mixed
  latency_ms INTEGER,
  ttft_ms INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  intent TEXT,
  confidence REAL,
  prompt_version TEXT,
  error_code TEXT,
  error_message TEXT,
  counts_against_quota INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_requests_tenant_time ON requests(tenant_id, created_at);

-- one row per backend attempt, so fallback decisions are inspectable
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES requests(id),
  seq INTEGER NOT NULL,
  backend TEXT NOT NULL,
  model TEXT,
  started_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,                -- ok|error|timeout_first_token|timeout_total|unusable_output|skipped_circuit_open|aborted
  error TEXT,
  latency_ms INTEGER,
  ttft_ms INTEGER,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  usage_source TEXT,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attempts_request ON attempts(request_id);

-- in-flight token reservations (pre-authorisation) so concurrent requests can't overspend
CREATE TABLE IF NOT EXISTS reservations (
  request_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export interface SeedTenant {
  id: string;
  name: string;
  plan: string;
  apiKey: string;
  allowedTiers: Tier[];
  tokenQuota: number;
  requestQuota: number;
}

export const DEMO_TENANTS: SeedTenant[] = [
  {
    id: "acme",
    name: "Acme Corp",
    plan: "pro",
    apiKey: process.env.ACME_API_KEY ?? "sk-acme-demo-7f3a9c",
    allowedTiers: ["fast", "strong", "local", "degraded"],
    tokenQuota: 300_000,
    requestQuota: 1_000,
  },
  {
    id: "globex",
    name: "Globex (free plan)",
    plan: "free",
    apiKey: process.env.GLOBEX_API_KEY ?? "sk-globex-demo-41be02",
    allowedTiers: ["fast", "local", "degraded"],
    tokenQuota: 40_000,
    requestQuota: 100,
  },
  {
    id: "initech",
    name: "Initech (tiny trial quota)",
    plan: "trial",
    apiKey: process.env.INITECH_API_KEY ?? "sk-initech-demo-c0ffee",
    allowedTiers: ["fast", "degraded"],
    tokenQuota: 4_000,
    requestQuota: 5,
  },
  {
    id: "eval",
    name: "Evaluation harness",
    plan: "internal",
    apiKey: process.env.EVAL_API_KEY ?? "sk-eval-demo-e7a1",
    allowedTiers: ["fast", "strong", "local", "degraded"],
    tokenQuota: 5_000_000,
    requestQuota: 100_000,
  },
];

export function openDb(path: string, seed: SeedTenant[] = DEMO_TENANTS): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
  db.exec(SCHEMA);
  const upsert = db.prepare(`
    INSERT INTO tenants (id, name, plan, api_key_hash, allowed_tiers, token_quota, request_quota, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, plan=excluded.plan, api_key_hash=excluded.api_key_hash,
      allowed_tiers=excluded.allowed_tiers, token_quota=excluded.token_quota, request_quota=excluded.request_quota`);
  for (const t of seed) {
    upsert.run(t.id, t.name, t.plan, hashKey(t.apiKey), JSON.stringify(t.allowedTiers), t.tokenQuota, t.requestQuota, Date.now());
  }
  // a crash mid-request would leave rows "in_progress" and reservations dangling; clean on boot
  db.exec(`UPDATE requests SET outcome='interrupted', finished_at=created_at WHERE outcome='in_progress'`);
  db.exec(`DELETE FROM reservations`);
  return db;
}
