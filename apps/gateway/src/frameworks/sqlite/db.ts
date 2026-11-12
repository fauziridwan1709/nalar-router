/**
 * The SQLite driver: opens the database, applies the schema and migrations, and seeds the demo
 * tenants and users. The queries themselves live in interface-adapters/gateways/sqlite.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Tier } from "../../entities/types.js";
import type { Role } from "../../entities/auth/rbac.js";
import { displayPrefix } from "../../entities/auth/apiKey.js";
import { hashKey } from "../../interface-adapters/gateways/crypto/hash.js";
import { hashPasswordSync } from "../../interface-adapters/gateways/crypto/passwords.js";

export type DB = DatabaseSync;

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
  pii_policy TEXT NOT NULL DEFAULT '{"mode":"mask"}', -- JSON PiiPolicy, see guardrails/pii.ts
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
  counts_against_quota INTEGER NOT NULL DEFAULT 1,
  credential TEXT,                      -- api key id, or user:<id> for console playground calls
  pii TEXT                              -- PII found in the input, as type:count pairs (never values)
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
  outcome TEXT NOT NULL,                -- ok|error|timeout_first_token|timeout_total|unusable_output|skipped_circuit_open|aborted|refused|escalated|classified
  error TEXT,
  latency_ms INTEGER,
  ttft_ms INTEGER,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  usage_source TEXT,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attempts_request ON attempts(request_id);

-- tenant API keys: only a digest of the secret is stored; plaintext is shown once at creation
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,                 -- public prefix + 2 chars, for recognising a key in lists
  last4 TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,        -- sha256(secret)
  scopes TEXT NOT NULL,                 -- JSON array of KeyScope
  created_by TEXT,                      -- users.id, NULL for seeded keys
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);

-- console users (one tenant each) and their sessions
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,           -- stored lower-case
  name TEXT NOT NULL,
  role TEXT NOT NULL,                   -- operator|owner|developer|viewer
  password_hash TEXT NOT NULL,          -- scrypt, see auth/passwords.ts
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,             -- sha256(cookie token)
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  tenant_id TEXT,
  actor_id TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,                 -- auth.login, auth.login_failed, key.create, key.revoke, quota.reset, chaos.set…
  target TEXT,
  ip TEXT,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_log(tenant_id, at);

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
    name: "Nalar internal (eval harness)",
    plan: "internal",
    apiKey: process.env.EVAL_API_KEY ?? "sk-eval-demo-e7a1",
    allowedTiers: ["fast", "strong", "local", "degraded"],
    tokenQuota: 5_000_000,
    requestQuota: 100_000,
    profile: ACME_PROFILE,
  },
];

export interface SeedUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  password: string;
  /** set when the password came from an env var: the demo sign-in page must not reveal it */
  passwordFromEnv?: boolean;
}

const demoPassword = (env: string, fallback: string) =>
  process.env[env] ? { password: process.env[env]!, passwordFromEnv: true } : { password: fallback };

/**
 * One console account per demo tenant, one per role, so every RBAC path can be tried.
 * Seeded only when DEMO_MODE is on (see main/container.ts). Override the passwords with env vars.
 */
export const DEMO_USERS: SeedUser[] = [
  {
    id: "usr_ops",
    tenantId: "eval",
    email: "ops@nalar.example",
    name: "Platform Operator",
    role: "operator",
    ...demoPassword("DEMO_PASSWORD_OPERATOR", "Nalar-Ops-2026!"),
  },
  {
    id: "usr_acme_owner",
    tenantId: "acme",
    email: "owner@acme.example",
    name: "Ayu Lestari",
    role: "owner",
    ...demoPassword("DEMO_PASSWORD_OWNER", "Acme-Owner-2026!"),
  },
  {
    id: "usr_globex_dev",
    tenantId: "globex",
    email: "dev@globex.example",
    name: "Bima Pratama",
    role: "developer",
    ...demoPassword("DEMO_PASSWORD_DEVELOPER", "Globex-Dev-2026!"),
  },
  {
    id: "usr_initech_viewer",
    tenantId: "initech",
    email: "viewer@initech.example",
    name: "Citra Wulandari",
    role: "viewer",
    ...demoPassword("DEMO_PASSWORD_VIEWER", "Initech-View-2026!"),
  },
];

export function openDb(path: string, seed: SeedTenant[] = DEMO_TENANTS, users: SeedUser[] = []): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
  db.exec(SCHEMA);
  // migration for databases created before tenant profiles existed
  const cols = (db.prepare("PRAGMA table_info(tenants)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("profile")) db.exec("ALTER TABLE tenants ADD COLUMN profile TEXT NOT NULL DEFAULT '{}'");
  if (!cols.includes("pii_policy"))
    db.exec(`ALTER TABLE tenants ADD COLUMN pii_policy TEXT NOT NULL DEFAULT '{"mode":"mask"}'`);
  const rcols = (db.prepare("PRAGMA table_info(requests)").all() as { name: string }[]).map((c) => c.name);
  if (!rcols.includes("credential")) db.exec("ALTER TABLE requests ADD COLUMN credential TEXT");
  if (!rcols.includes("pii")) db.exec("ALTER TABLE requests ADD COLUMN pii TEXT");
  const upsert = db.prepare(`
    INSERT INTO tenants (id, name, plan, api_key_hash, allowed_tiers, token_quota, request_quota, profile, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, plan=excluded.plan, api_key_hash=excluded.api_key_hash,
      allowed_tiers=excluded.allowed_tiers, token_quota=excluded.token_quota, request_quota=excluded.request_quota,
      profile=excluded.profile`);
  for (const t of seed) {
    upsert.run(
      t.id,
      t.name,
      t.plan,
      hashKey(t.apiKey),
      JSON.stringify(t.allowedTiers),
      t.tokenQuota,
      t.requestQuota,
      JSON.stringify(t.profile ?? {}),
      Date.now(),
    );
    // the seeded key is an ordinary api_keys row, so it can be listed, scoped and revoked like any other
    db.prepare(
      `INSERT INTO api_keys (id, tenant_id, name, prefix, last4, key_hash, scopes, created_by, created_at)
       VALUES (?, ?, 'Seeded demo key', ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET key_hash=excluded.key_hash, prefix=excluded.prefix, last4=excluded.last4`,
    ).run(
      `key_seed_${t.id}`,
      t.id,
      displayPrefix(t.apiKey),
      t.apiKey.slice(-4),
      hashKey(t.apiKey),
      JSON.stringify(["support.answer", "chat.completions", "usage.read"]),
      Date.now(),
    );
  }
  // users are created once; an existing account keeps its password (hashing is deliberately slow)
  const userExists = db.prepare("SELECT 1 FROM users WHERE id = ? OR email = ?");
  const addUser = db.prepare(
    `INSERT INTO users (id, tenant_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const u of users) {
    if (!userExists.get(u.id, u.email.toLowerCase())) {
      addUser.run(u.id, u.tenantId, u.email.toLowerCase(), u.name, u.role, hashPasswordSync(u.password), Date.now());
    }
  }
  // a crash mid-request would leave rows "in_progress" and reservations dangling; clean on boot
  db.exec(`UPDATE requests SET outcome='interrupted', finished_at=created_at WHERE outcome='in_progress'`);
  db.exec(`DELETE FROM reservations`);
  return db;
}
