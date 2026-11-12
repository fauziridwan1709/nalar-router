/**
 * Console users and sessions.
 * - The session token is 256 random bits, sent only in an HttpOnly, SameSite=Strict cookie;
 *   the database keeps its SHA-256, so a leaked database can't be replayed as live sessions.
 * - Each session has its own CSRF token, required on every state-changing console request.
 * - Sessions expire after 2 h idle or 12 h total, whichever comes first, and are rotated on sign-in.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync as DB } from "node:sqlite";
import { isRole } from "../../../entities/auth/rbac.js";
import { SESSION_IDLE_MS, SESSION_MAX_MS, type User } from "../../../entities/auth/user.js";
import type { AuditLog, Member, SessionStore, UserDirectory } from "../../../use-cases/ports/identity.js";
import { hashKey } from "../crypto/hash.js";
export type { User };

const toUser = (r: any): User | null =>
  r && isRole(r.role) ? { id: r.id, tenantId: r.tenant_id, email: r.email, name: r.name, role: r.role } : null;

export function findUserForLogin(db: DB, email: string) {
  const r = db.prepare("SELECT * FROM users WHERE email = ? AND disabled_at IS NULL").get(email.toLowerCase()) as any;
  return r ? { user: toUser(r), passwordHash: r.password_hash as string } : null;
}

export function createSession(db: DB, userId: string, meta: { ip?: string; userAgent?: string }, now = Date.now()) {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  db.prepare(
    `INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashKey(token),
    userId,
    csrf,
    now,
    now,
    now + SESSION_MAX_MS,
    meta.ip ?? null,
    (meta.userAgent ?? "").slice(0, 200),
  );
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, userId);
  // housekeeping: drop expired sessions so the table can't grow without bound
  db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?").run(now, now - SESSION_IDLE_MS);
  return { token, csrf };
}

export function getSession(db: DB, token: string, now = Date.now()) {
  if (!token || token.length > 100) return null;
  const idHash = hashKey(token);
  const s = db.prepare("SELECT * FROM sessions WHERE id_hash = ?").get(idHash) as any;
  if (!s) return null;
  if (s.expires_at <= now || now - s.last_seen_at > SESSION_IDLE_MS) {
    db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
    return null;
  }
  const user = toUser(db.prepare("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL").get(s.user_id));
  if (!user) return null;
  if (now - s.last_seen_at > 30_000)
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").run(now, idHash);
  return { user, csrf: s.csrf_token as string, idHash };
}

export function deleteSession(db: DB, token: string) {
  db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(hashKey(token));
}

export function audit(
  db: DB,
  e: {
    tenantId: string | null;
    actor: User | null;
    action: string;
    target?: string | null;
    ip?: string;
    meta?: Record<string, unknown>;
  },
  now = Date.now(),
) {
  try {
    db.prepare(
      `INSERT INTO audit_log (at, tenant_id, actor_id, actor_email, action, target, ip, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      now,
      e.tenantId,
      e.actor?.id ?? null,
      e.actor?.email ?? null,
      e.action,
      e.target ?? null,
      e.ip ?? null,
      JSON.stringify(e.meta ?? {}),
    );
  } catch (err) {
    console.error("audit write failed", err); // an audit failure must not break the action's response
  }
}

export function listAudit(db: DB, tenantId: string | null, limit = 50) {
  const rows = tenantId
    ? db.prepare("SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY at DESC, id DESC LIMIT ?").all(tenantId, limit)
    : db.prepare("SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?").all(limit);
  return rows.map((r: any) => ({
    id: r.id,
    at: r.at,
    tenantId: r.tenant_id,
    actorEmail: r.actor_email,
    action: r.action,
    target: r.target,
    meta: JSON.parse(r.meta),
  }));
}

export function listMembers(db: DB, tenantId: string | null): Member[] {
  const cols = "id, tenant_id, email, name, role, created_at, last_login_at, disabled_at";
  const rows = (
    tenantId
      ? db.prepare(`SELECT ${cols} FROM users WHERE tenant_id = ? ORDER BY role, email`).all(tenantId)
      : db.prepare(`SELECT ${cols} FROM users ORDER BY tenant_id, role, email`).all()
  ) as any[];
  return rows.map((u) => ({
    id: u.id,
    tenantId: u.tenant_id,
    email: u.email,
    name: u.name,
    role: u.role,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    disabled: !!u.disabled_at,
  }));
}

/** the UserDirectory port on SQLite */
export const sqliteUserDirectory = (db: DB): UserDirectory => ({
  findForLogin: (email) => findUserForLogin(db, email),
  members: (tenantId) => listMembers(db, tenantId),
});

/** the SessionStore port on SQLite */
export const sqliteSessionStore = (db: DB): SessionStore => ({
  create: (userId, meta) => createSession(db, userId, meta),
  get: (token) => getSession(db, token),
  delete: (token) => deleteSession(db, token),
});

/** the AuditLog port on SQLite */
export const sqliteAuditLog = (db: DB): AuditLog => ({
  record: (e) => audit(db, e),
  list: (tenantId, limit) => listAudit(db, tenantId, limit),
});
