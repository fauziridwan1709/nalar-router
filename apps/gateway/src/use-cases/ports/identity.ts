/** Console identity: users, sessions, password checks and the audit trail. */
import type { Role } from "../../entities/auth/rbac.js";
import type { User } from "../../entities/auth/user.js";

export interface Member {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  createdAt: number;
  lastLoginAt: number | null;
  disabled: boolean;
}

export interface UserDirectory {
  /** an enabled account by email, with its stored password hash; `user` is null for an unknown role */
  findForLogin(email: string): { user: User | null; passwordHash: string } | null;
  /** one tenant's members, or everyone's when `tenantId` is null */
  members(tenantId: string | null): Member[];
}

export interface SessionStore {
  /** a new session; the token goes to the client once, the store keeps its hash */
  create(userId: string, meta: { ip?: string; userAgent?: string }): { token: string; csrf: string };
  /** the live session for a token, or null if it is unknown, expired or idle too long */
  get(token: string): { user: User; csrf: string } | null;
  delete(token: string): void;
}

export interface PasswordVerifier {
  verify(password: string, stored: string): Promise<boolean>;
  /** a hash to verify against when the account doesn't exist, so both paths take the same time */
  dummyHash(): string;
}

export interface AuditEntry {
  tenantId: string | null;
  actor: User | null;
  action: string;
  target?: string | null;
  ip?: string;
  meta?: Record<string, unknown>;
}

export interface AuditRecord {
  id: number;
  at: number;
  tenantId: string | null;
  actorEmail: string | null;
  action: string;
  target: string | null;
  meta: unknown;
}

export interface AuditLog {
  /** never throws: an audit failure must not break the action it records */
  record(e: AuditEntry): void;
  list(tenantId: string | null, limit: number): AuditRecord[];
}
