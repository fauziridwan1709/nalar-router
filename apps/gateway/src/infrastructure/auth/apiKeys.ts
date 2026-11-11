/**
 * Tenant API keys.
 * - 192 bits from the CSPRNG, prefixed `nr_live_` so secret scanners and humans can spot a leak.
 * - Only a SHA-256 digest is stored. A slow hash isn't needed: the secret is random, not a password.
 * - The plaintext is returned once, at creation. After that the console shows the prefix and last 4.
 * - Keys carry scopes (least privilege), an optional expiry, and can be revoked. Revoked and
 *   expired keys fail with the same error as unknown keys, so a caller learns nothing extra.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { DB } from "../db/db.js";
import { hashKey } from "../db/db.js";

export const KEY_SCOPES = ["support.answer", "chat.completions", "usage.read"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];
export const KEY_PREFIX = "nr_live_";
export const MAX_ACTIVE_KEYS_PER_TENANT = 10;
export const EXPIRY_DAYS = [7, 30, 90, 365] as const;

export interface ApiKeyRow {
  id: string;
  tenantId: string;
  name: string;
  prefix: string;
  last4: string;
  scopes: KeyScope[];
  createdBy: string | null;
  createdByEmail: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  status: "active" | "expired" | "revoked";
}

function toRow(r: any, now = Date.now()): ApiKeyRow {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, prefix: r.prefix, last4: r.last4,
    scopes: JSON.parse(r.scopes), createdBy: r.created_by, createdByEmail: r.created_by_email ?? null,
    createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, lastUsedAt: r.last_used_at,
    status: r.revoked_at ? "revoked" : r.expires_at && r.expires_at <= now ? "expired" : "active",
  };
}

export const newSecret = () => KEY_PREFIX + randomBytes(24).toString("base64url");

/** what a list may show: the public prefix plus 2 characters, and the last 4 (16 of 192 bits) */
export const displayPrefix = (secret: string) => (secret.startsWith(KEY_PREFIX) ? secret.slice(0, KEY_PREFIX.length + 2) : secret.slice(0, 4));

export function insertKey(
  db: DB,
  k: { id?: string; tenantId: string; name: string; secret: string; scopes: readonly KeyScope[]; createdBy: string | null; expiresAt: number | null; now?: number },
) {
  const id = k.id ?? `key_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db.prepare(
    `INSERT INTO api_keys (id, tenant_id, name, prefix, last4, key_hash, scopes, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET key_hash=excluded.key_hash, prefix=excluded.prefix, last4=excluded.last4,
       scopes=excluded.scopes, revoked_at=NULL`,
  ).run(id, k.tenantId, k.name, displayPrefix(k.secret), k.secret.slice(-4), hashKey(k.secret), JSON.stringify(k.scopes),
    k.createdBy, k.now ?? Date.now(), k.expiresAt);
  return id;
}

export function createKey(
  db: DB,
  input: { tenantId: string; name: string; scopes: readonly KeyScope[]; expiresInDays: number | null; createdBy: string },
  now = Date.now(),
) {
  const secret = newSecret();
  db.exec("BEGIN IMMEDIATE");
  try {
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
      .get(input.tenantId, now) as { n: number };
    if (n >= MAX_ACTIVE_KEYS_PER_TENANT) {
      db.exec("ROLLBACK");
      return { error: "limit" as const };
    }
    const id = insertKey(db, {
      tenantId: input.tenantId, name: input.name, secret, scopes: input.scopes, createdBy: input.createdBy,
      expiresAt: input.expiresInDays ? now + input.expiresInDays * 86_400_000 : null, now,
    });
    db.exec("COMMIT");
    return { key: getKey(db, id, now)!, secret };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already closed */ }
    throw e;
  }
}

const SELECT = `SELECT k.*, u.email AS created_by_email FROM api_keys k LEFT JOIN users u ON u.id = k.created_by`;

export function getKey(db: DB, id: string, now = Date.now()) {
  const r = db.prepare(`${SELECT} WHERE k.id = ?`).get(id);
  return r ? toRow(r, now) : null;
}

export function listKeys(db: DB, tenantId: string, now = Date.now()) {
  return db.prepare(`${SELECT} WHERE k.tenant_id = ? ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`).all(tenantId).map((r) => toRow(r, now));
}

export function revokeKey(db: DB, id: string, now = Date.now()) {
  db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
}

/** the active key for a presented secret, or null. Also bumps last_used_at (at most once a minute). */
export function authenticateKey(db: DB, secret: string, now = Date.now()) {
  if (!secret || secret.length > 200) return null;
  const r = db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(hashKey(secret)) as any;
  if (!r || r.revoked_at || (r.expires_at && r.expires_at <= now)) return null;
  if (!r.last_used_at || now - r.last_used_at > 60_000) {
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, r.id);
  }
  return toRow(r, now);
}
