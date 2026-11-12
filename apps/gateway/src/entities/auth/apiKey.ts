/**
 * Tenant API key rules: the scopes a key can carry, the expiry choices, the per-tenant cap,
 * and what a listing may show of a secret. Storage and hashing live in the SQLite gateway.
 */
export const KEY_SCOPES = ["support.answer", "chat.completions", "usage.read"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];
export const KEY_PREFIX = "nr_live_";
export const MAX_ACTIVE_KEYS_PER_TENANT = 10;
export const EXPIRY_DAYS = [7, 30, 90, 365] as const;

export interface ApiKey {
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

/** what a list may show: the public prefix plus 2 characters, and the last 4 (16 of 192 bits) */
export const displayPrefix = (secret: string) => (secret.startsWith(KEY_PREFIX) ? secret.slice(0, KEY_PREFIX.length + 2) : secret.slice(0, 4));
