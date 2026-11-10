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
  profile TEXT NOT NULL DEFAULT '{}',   -- JSON: company facts used to fill answer placeholders
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
  /** company facts that fill {{…}} slots in answers (support phone, hours, website, …) */
  profile?: Record<string, string>;
}

const ACME_PROFILE: Record<string, string> = {
  "Company Name": "Acme Corp",
  Company: "Acme Corp",
  "Customer Support Phone Number": "+62 21 5088 1234",
  "Toll-Free Number": "0800-1-226-3000",
  "Customer Support Hours": "business hours (Mon–Fri, 08:00–20:00 WIB)",
  "Customer Support Email": "support@acme.example",
  "Customer Service Email": "support@acme.example",
  "Website URL": "acme.example",
  "Online Company Portal Info": "Acme account (acme.example/account)",
  "Login Page URL": "acme.example/login",
  "Login URL": "acme.example/login",
  "Help Center URL": "help.acme.example",
  "Customer Support Live Chat URL": "acme.example/chat",
  "Account Recovery Page URL": "acme.example/account/recover",
  "Password Recovery Page URL": "acme.example/account/recover",
  "Profile Recovery Page URL": "acme.example/account/recover",
  "User Key Retrieval Page URL": "acme.example/account/recover",
  "Store Location": "Acme Store, Jl. Jend. Sudirman No. 1, Jakarta",
  "Standard Shipping Days": "3–5 business days",
  "Expedited Shipping Days": "1–2 business days",
  "Online Order Interaction": "My Orders",
};

export const DEMO_TENANTS: SeedTenant[] = [
  {
    id: "acme",
    name: "Acme Corp",
    plan: "pro",
    apiKey: process.env.ACME_API_KEY ?? "sk-acme-demo-7f3a9c",
    allowedTiers: ["fast", "strong", "local", "degraded"],
    tokenQuota: 300_000,
    requestQuota: 1_000,
    profile: ACME_PROFILE,
  },
  {
    id: "globex",
    name: "Globex (free plan)",
    plan: "free",
    apiKey: process.env.GLOBEX_API_KEY ?? "sk-globex-demo-41be02",
    allowedTiers: ["fast", "local", "degraded"],
    tokenQuota: 40_000,
    requestQuota: 100,
    profile: {
      "Company Name": "Globex",
      Company: "Globex",
      "Customer Support Phone Number": "+62 21 2900 7788",
      "Customer Support Hours": "opening hours (daily, 09:00–18:00 WIB)",
      "Customer Support Email": "help@globex.example",
      "Website URL": "globex.example",
      "Online Company Portal Info": "Globex app",
      "Login Page URL": "globex.example/signin",
    },
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
    profile: ACME_PROFILE,
  },
];

export function openDb(path: string, seed: SeedTenant[] = DEMO_TENANTS): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
  db.exec(SCHEMA);
  // migration for databases created before tenant profiles existed
  const cols = (db.prepare("PRAGMA table_info(tenants)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("profile")) db.exec("ALTER TABLE tenants ADD COLUMN profile TEXT NOT NULL DEFAULT '{}'");
  const upsert = db.prepare(`
    INSERT INTO tenants (id, name, plan, api_key_hash, allowed_tiers, token_quota, request_quota, profile, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, plan=excluded.plan, api_key_hash=excluded.api_key_hash,
      allowed_tiers=excluded.allowed_tiers, token_quota=excluded.token_quota, request_quota=excluded.request_quota,
      profile=excluded.profile`);
  for (const t of seed) {
    upsert.run(t.id, t.name, t.plan, hashKey(t.apiKey), JSON.stringify(t.allowedTiers), t.tokenQuota, t.requestQuota,
      JSON.stringify(t.profile ?? {}), Date.now());
  }
  // a crash mid-request would leave rows "in_progress" and reservations dangling; clean on boot
  db.exec(`UPDATE requests SET outcome='interrupted', finished_at=created_at WHERE outcome='in_progress'`);
  db.exec(`DELETE FROM reservations`);
  return db;
}
