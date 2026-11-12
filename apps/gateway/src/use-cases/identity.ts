/**
 * Console sign-in, sessions and sign-out.
 * - One message for every bad credential, and one scrypt run whether or not the account exists,
 *   so a guesser learns nothing about which emails are registered.
 * - Failed attempts are limited per account and per IP; a success clears the account's counter.
 * - Every sign-in, failed sign-in and sign-out is audited.
 */
import type { User } from "../entities/auth/user.js";
import { GatewayError } from "../entities/errors.js";
import type { Tenant } from "../entities/types.js";
import type { Actor } from "./access.js";
import type { GatewayDeps } from "./deps.js";

export interface SignInInput {
  email: string;
  password: string;
  ip: string;
  userAgent?: string;
}

export async function signIn(deps: GatewayDeps, input: SignInInput): Promise<{ user: User; tenant: Tenant | null; token: string; csrf: string }> {
  const { email, password, ip } = input;
  const { perAccount, perIp } = deps.signInLimits;
  const wait = Math.max(perAccount.blockedFor(`acct:${email}`), perIp.blockedFor(`ip:${ip}`));
  if (wait > 0) {
    throw new GatewayError(429, "too_many_attempts", "Too many sign-in attempts. Try again later.", { retryAfterSeconds: wait });
  }

  const found = deps.users.findForLogin(email);
  // always run one scrypt, so a missing account takes as long as a wrong password
  const ok = await deps.passwords.verify(password, found?.passwordHash ?? deps.passwords.dummyHash());
  if (!found?.user || !ok) {
    perAccount.fail(`acct:${email}`);
    perIp.fail(`ip:${ip}`);
    deps.audit.record({ tenantId: found?.user?.tenantId ?? null, actor: null, action: "auth.login_failed", target: found?.user ? email : null, ip });
    throw new GatewayError(401, "invalid_credentials", "Invalid email or password.");
  }
  perAccount.clear(`acct:${email}`);
  const user = found.user;
  const { token, csrf } = deps.sessions.create(user.id, { ip, userAgent: input.userAgent });
  deps.audit.record({ tenantId: user.tenantId, actor: user, action: "auth.login", ip });
  return { user, tenant: deps.tenants.get(user.tenantId), token, csrf };
}

/** the session behind a cookie token, or 401 */
export function resolveSession(deps: Pick<GatewayDeps, "sessions">, token: string | null): { user: User; csrf: string } {
  const s = token ? deps.sessions.get(token) : null;
  if (!s) throw new GatewayError(401, "unauthenticated", "Sign in to continue.");
  return s;
}

export function signOut(deps: GatewayDeps, actor: Actor, token: string | null) {
  if (token) deps.sessions.delete(token);
  deps.audit.record({ tenantId: actor.user.tenantId, actor: actor.user, action: "auth.logout", ip: actor.ip });
}

/** the seeded demo accounts for the sign-in page; 404 unless demo mode is on */
export function listDemoAccounts(deps: GatewayDeps, demoMode: boolean) {
  if (!demoMode) throw new GatewayError(404, "not_found", "Not found.");
  return deps.demoAccounts.map((a) => ({
    email: a.email,
    role: a.role,
    tenant: deps.tenants.get(a.tenantId)?.name ?? a.tenantId,
    password: a.password,
  }));
}
