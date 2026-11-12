/** Tenant API keys. The repository stores a hash; the plaintext secret is returned once, by `create`. */
import type { ApiKey, KeyScope } from "../../entities/auth/apiKey.js";

export interface NewApiKey {
  tenantId: string;
  name: string;
  scopes: readonly KeyScope[];
  expiresInDays: number | null;
  createdBy: string;
}

export interface ApiKeyRepository {
  /** atomically enforces MAX_ACTIVE_KEYS_PER_TENANT */
  create(input: NewApiKey): { key: ApiKey; secret: string } | { error: "limit" };
  get(id: string): ApiKey | null;
  list(tenantId: string): ApiKey[];
  revoke(id: string): void;
  /** the active key for a presented secret, or null for unknown, revoked and expired keys alike */
  authenticate(secret: string): ApiKey | null;
}
