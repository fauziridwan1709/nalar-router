/**
 * The console API: session sign-in, RBAC, tenant scoping and API key management.
 *
 * Rules every handler here follows:
 * - Sessions only (HttpOnly cookie). The console never sees a tenant API key or the admin token.
 * - Permission checks happen here, on the server. The console hides what a role can't do,
 *   but that is a convenience, not the control.
 * - A non-operator is pinned to their own tenant. Asking for another tenant's object returns
 *   404, the same as a missing one, so ids can't be probed across tenants.
 * - Every state-changing call needs the session's CSRF token and a same-origin request.
 * - Error messages say what went wrong for the caller, never why internally (no stack traces,
 *   no "this email exists", no required-permission names).
 */
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Gateway } from "../../gateway.js";
import { GatewayError, publicAttemptError } from "../../domain/errors.js";
import { DEMO_USERS } from "../../infrastructure/db/db.js";
import { getTenant, listTenants, setPiiPolicy, type Tenant } from "../../infrastructure/db/tenants.js";
import { PII_LABEL, PII_MODES, PII_TYPES, scanPii } from "../../domain/guardrails/pii.js";
import { getUsage, resetQuota } from "../../infrastructure/db/quota.js";
import { getRequestDetail, listRequests } from "../../infrastructure/db/metering.js";
import { computeMetrics, RANGES, type RangeKey } from "../../infrastructure/db/metrics.js";
import type { ChaosMode } from "../../infrastructure/backends/chaos.js";
import { can, GRANTS, type Permission } from "../../domain/auth/rbac.js";
import { dummyHash, verifyPassword } from "../../infrastructure/auth/passwords.js";
import { FailureLimiter } from "../../infrastructure/auth/rateLimit.js";
import { audit, createSession, deleteSession, findUserForLogin, getSession, listAudit, SESSION_MAX_MS, type User } from "../../infrastructure/auth/sessions.js";
import { createKey, EXPIRY_DAYS, getKey, KEY_SCOPES, listKeys, MAX_ACTIVE_KEYS_PER_TENANT, revokeKey } from "../../infrastructure/auth/apiKeys.js";
import { chatSpec, supportSpec, type RunCapability } from "./specs.js";
import { clearSessionCookie, readCookie, safeEq, sameOrigin, sessionCookieName, setSessionCookie } from "./security.js";
import { backendsFull, ChaosBody, listEvals } from "./shared.js";

const LoginBody = z
  .object({
    email: z.string().trim().toLowerCase().max(254).email(),
    password: z.string().min(1).max(256),
  })
  .strict();

const KeyBody = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "name is required")
      .max(64, "name is at most 64 characters")
      .regex(/^[\p{L}\p{N} ._()-]+$/u, "name may use letters, numbers, spaces and . _ ( ) -"),
    scopes: z
      .array(z.enum(KEY_SCOPES))
      .min(1, "pick at least one scope")
      .max(KEY_SCOPES.length)
      .refine((s) => new Set(s).size === s.length, "scopes must be unique"),
    expiresInDays: z.union([z.literal(EXPIRY_DAYS[0]), z.literal(EXPIRY_DAYS[1]), z.literal(EXPIRY_DAYS[2]), z.literal(EXPIRY_DAYS[3]), z.null()]),
  })
  .strict();

const PlaygroundBody = z.object({ tenant: z.string().max(64).optional() }).passthrough();
const PiiPolicyBody = z.object({ mode: z.enum(PII_MODES), types: z.array(z.enum(PII_TYPES)).max(PII_TYPES.length) }).strict();
const PiiTestBody = z.object({ text: z.string().max(2000, "text is at most 2000 characters") }).strict();

const ID = /^[a-z0-9_]{1,64}$/;

const publicUser = (u: User, t: Tenant | null) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  tenant: t ? { id: t.id, name: t.name, plan: t.plan } : null,
  permissions: GRANTS[u.role],
});

export function mountConsole(app: Express, gw: Gateway, runCapability: RunCapability) {
  const cfg = gw.config;
  const perAccount = new FailureLimiter(cfg.auth.maxFailuresPerAccount, cfg.auth.failureWindowMs);
  const perIp = new FailureLimiter(cfg.auth.maxFailuresPerIp, cfg.auth.failureWindowMs);

  // ---------- middleware ----------
  const session = (req: Request, _res: Response, next: NextFunction) => {
    const token = readCookie(req, sessionCookieName(req, cfg));
    const s = token ? getSession(gw.db, token) : null;
    if (!s) return next(new GatewayError(401, "unauthenticated", "Sign in to continue."));
    req.user = s.user;
    req.csrf = s.csrf;
    next();
  };
  /** state-changing requests: same origin, and the per-session CSRF token in a header */
  const csrf = (req: Request, _res: Response, next: NextFunction) => {
    const sent = req.header("x-csrf-token") ?? "";
    if (!sameOrigin(req) || !req.csrf || !safeEq(sent, req.csrf)) {
      return next(new GatewayError(403, "csrf_failed", "Your session could not be verified. Reload the page and try again."));
    }
    next();
  };
  const need = (p: Permission) => (req: Request, _res: Response, next: NextFunction) =>
    can(req.user!.role, p) ? next() : next(new GatewayError(403, "forbidden", "You don't have permission to do that."));

  /**
   * Which tenant a request is about. Operators may pick any tenant (or all, when `allowAll`);
   * everyone else always gets their own, whatever they asked for.
   */
  function scopeTenant(req: Request, allowAll: boolean): string | null {
    const asked = typeof req.query.tenant === "string" ? req.query.tenant : "";
    if (!can(req.user!.role, "tenants:all")) return req.user!.tenantId;
    if (!asked) return allowAll ? null : req.user!.tenantId;
    if (!ID.test(asked) || !getTenant(gw.db, asked)) throw new GatewayError(404, "not_found", "Tenant not found.");
    return asked;
  }
  const isOperator = (req: Request) => can(req.user!.role, "tenants:all");

  /** what a tenant user may see of a metered request: provider error text stays with operators */
  function redactRequest<T extends Record<string, any>>(req: Request, r: T): T {
    if (isOperator(req)) return r;
    const clientFacing = r.outcome === "rejected" || r.outcome === "quota_exceeded";
    return {
      ...r,
      error_message: clientFacing ? r.error_message : null,
      attempts: Array.isArray(r.attempts) ? r.attempts.map((a: any) => ({ ...a, error: a.error ? publicAttemptError(a.outcome) : null })) : r.attempts,
    };
  }

  // ---------- auth ----------
  app.post("/api/auth/login", async (req, res) => {
    if (!sameOrigin(req)) throw new GatewayError(403, "csrf_failed", "Sign-in must come from the console.");
    const parsed = LoginBody.safeParse(req.body ?? {});
    // one message for every bad input: don't coach a guesser on the format
    if (!parsed.success) throw new GatewayError(400, "invalid_request", "Enter your email address and password.");
    const { email, password } = parsed.data;
    const ip = req.ip ?? "unknown";
    const wait = Math.max(perAccount.blockedFor(`acct:${email}`), perIp.blockedFor(`ip:${ip}`));
    if (wait > 0) {
      throw new GatewayError(429, "too_many_attempts", "Too many sign-in attempts. Try again later.", { retryAfterSeconds: wait });
    }

    const found = findUserForLogin(gw.db, email);
    // always run one scrypt, so a missing account takes as long as a wrong password
    const ok = await verifyPassword(password, found?.passwordHash ?? dummyHash());
    if (!found?.user || !ok) {
      perAccount.fail(`acct:${email}`);
      perIp.fail(`ip:${ip}`);
      audit(gw.db, { tenantId: found?.user?.tenantId ?? null, actor: null, action: "auth.login_failed", target: found?.user ? email : null, ip });
      throw new GatewayError(401, "invalid_credentials", "Invalid email or password.");
    }
    perAccount.clear(`acct:${email}`);
    const user = found.user;
    const { token, csrf: csrfToken } = createSession(gw.db, user.id, { ip, userAgent: req.header("user-agent") });
    setSessionCookie(req, res, cfg, token, SESSION_MAX_MS);
    audit(gw.db, { tenantId: user.tenantId, actor: user, action: "auth.login", ip });
    res.json({ user: publicUser(user, getTenant(gw.db, user.tenantId)), csrfToken });
  });

  app.post("/api/auth/logout", session, csrf, (req, res) => {
    const token = readCookie(req, sessionCookieName(req, cfg));
    if (token) deleteSession(gw.db, token);
    clearSessionCookie(req, res, cfg);
    audit(gw.db, { tenantId: req.user!.tenantId, actor: req.user!, action: "auth.logout", ip: req.ip });
    res.status(204).end();
  });

  app.get("/api/auth/session", session, (req, res) => {
    res.json({ user: publicUser(req.user!, getTenant(gw.db, req.user!.tenantId)), csrfToken: req.csrf });
  });

  // demo convenience for reviewers: the four seeded accounts. Off unless DEMO_MODE=true.
  app.get("/api/auth/demo-accounts", (_req, res) => {
    if (!cfg.demoMode) throw new GatewayError(404, "not_found", "Not found.");
    res.json(
      DEMO_USERS.map((u) => ({
        email: u.email,
        role: u.role,
        tenant: getTenant(gw.db, u.tenantId)?.name ?? u.tenantId,
        // a password set through the environment is somebody's real choice: never echo it
        password: u.passwordFromEnv ? null : u.password,
      })),
    );
  });

  // ---------- console data ----------
  app.get("/api/console/config", session, (req, res) => {
    const tenants = isOperator(req) ? listTenants(gw.db) : [getTenant(gw.db, req.user!.tenantId)!];
    res.json({
      tenants: tenants.map((t) => ({ id: t.id, name: t.name, plan: t.plan, allowedTiers: t.allowedTiers, profile: t.profile })),
      backends: gw.backends.map((b) => ({ id: b.config.id, tier: b.config.tier, model: b.config.model, location: b.config.location, enabled: b.config.enabled })),
      intents: gw.intents,
      keyScopes: KEY_SCOPES,
      keyExpiryDays: EXPIRY_DAYS,
      maxActiveKeys: MAX_ACTIVE_KEYS_PER_TENANT,
    });
  });

  app.get("/api/console/metrics", session, need("dashboard:read"), (req, res) => {
    const range = String(req.query.range ?? "24h");
    if (!(range in RANGES)) throw new GatewayError(400, "invalid_request", `range must be one of ${Object.keys(RANGES).join(", ")}`);
    const backend = typeof req.query.backend === "string" && req.query.backend ? req.query.backend : undefined;
    if (backend && !gw.backends.some((b) => b.config.id === backend)) throw new GatewayError(400, "invalid_request", "Unknown backend.");
    res.json(computeMetrics(gw.db, range as RangeKey, { tenantId: scopeTenant(req, true) ?? undefined, backend }));
  });

  app.get("/api/console/requests", session, need("requests:read"), (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    res.json(listRequests(gw.db, { tenantId: scopeTenant(req, true) ?? undefined, limit }).map((r) => redactRequest(req, r)));
  });

  app.get("/api/console/requests/:id", session, need("requests:read"), (req, res) => {
    const id = String(req.params.id);
    const d = /^req_[a-z0-9]{1,40}$/.test(id) ? getRequestDetail(gw.db, id) : null;
    if (!d || (!isOperator(req) && d.tenant_id !== req.user!.tenantId)) throw new GatewayError(404, "not_found", "Request not found.");
    // operators reading another tenant's data leave a trail
    if (d.tenant_id !== req.user!.tenantId) {
      audit(gw.db, { tenantId: d.tenant_id, actor: req.user!, action: "data.cross_tenant_read", target: id, ip: req.ip });
    }
    res.json(redactRequest(req, d));
  });

  app.get("/api/console/usage", session, need("usage:read"), (req, res) => {
    const scoped = scopeTenant(req, true);
    const tenants = scoped ? [getTenant(gw.db, scoped)!] : listTenants(gw.db);
    res.json(
      tenants.map((t) => {
        const usage = getUsage(gw.db, t);
        // quota rejections this period, and whether the newest one came after the last admitted request:
        // a tenant can be refused while under 100% because each request reserves its prompt + a minimum answer
        const q = gw.db
          .prepare(
            `SELECT SUM(error_code = 'quota_exceeded') AS rejected,
                    MAX(CASE WHEN error_code = 'quota_exceeded' THEN created_at END) AS lastRejectedAt,
                    MAX(CASE WHEN counts_against_quota = 1 THEN created_at END) AS lastAdmittedAt
               FROM requests WHERE tenant_id = ? AND created_at >= ?`,
          )
          .get(t.id, usage.periodStart) as { rejected: number | null; lastRejectedAt: number | null; lastAdmittedAt: number | null };
        return {
          tenant: t.id, name: t.name, plan: t.plan, allowedTiers: t.allowedTiers, profileFields: Object.keys(t.profile).length,
          ...usage,
          quotaRejections: q.rejected ?? 0,
          rejecting: q.lastRejectedAt != null && q.lastRejectedAt >= (q.lastAdmittedAt ?? 0),
          outcomes: gw.db.prepare("SELECT outcome, COUNT(*) AS n FROM requests WHERE tenant_id = ? GROUP BY outcome").all(t.id),
        };
      }),
    );
  });

  app.post("/api/console/tenants/:id/reset-quota", session, csrf, need("quota:reset"), (req, res) => {
    const id = String(req.params.id);
    const t = ID.test(id) ? getTenant(gw.db, id) : null;
    if (!t) throw new GatewayError(404, "not_found", "Tenant not found.");
    resetQuota(gw.db, t.id);
    audit(gw.db, { tenantId: t.id, actor: req.user!, action: "quota.reset", target: t.id, ip: req.ip });
    res.json(getUsage(gw.db, getTenant(gw.db, t.id)!));
  });

  app.get("/api/console/backends", session, need("backends:read"), (req, res) => {
    const full = backendsFull(gw);
    if (isOperator(req)) return res.json(full);
    // tenants see availability, not probe internals, breaker errors or fault-injection settings
    res.json(
      full.map((b) => ({
        id: b.id, tier: b.tier, model: b.model, enabled: b.enabled, location: b.location,
        health: b.health ? { label: b.health.label, availability: b.health.availability, checkedAt: b.health.checkedAt } : undefined,
        breaker: { state: b.breaker.state },
      })),
    );
  });

  app.put("/api/console/chaos/:backend", session, csrf, need("chaos:write"), (req, res) => {
    const id = String(req.params.backend);
    if (!gw.backends.some((b) => b.config.id === id)) throw new GatewayError(404, "not_found", "Backend not found.");
    const body = ChaosBody.parse(req.body ?? {});
    audit(gw.db, { tenantId: null, actor: req.user!, action: "chaos.set", target: id, ip: req.ip, meta: body });
    res.json(gw.chaos.set(id, body as { mode?: ChaosMode }));
  });

  app.delete("/api/console/chaos", session, csrf, need("chaos:write"), (req, res) => {
    gw.chaos.clear();
    gw.breaker.reset();
    audit(gw.db, { tenantId: null, actor: req.user!, action: "chaos.clear", ip: req.ip });
    res.json({ ok: true });
  });

  app.get("/api/console/evals", session, need("evals:read"), (_req, res) => {
    res.json(listEvals(gw));
  });

  // ---------- API keys ----------
  app.get("/api/console/keys", session, need("keys:read"), (req, res) => {
    const tenantId = scopeTenant(req, false)!;
    res.json({ tenant: tenantId, keys: listKeys(gw.db, tenantId) });
  });

  app.post("/api/console/keys", session, csrf, need("keys:create"), (req, res) => {
    const tenantId = scopeTenant(req, false)!;
    const body = KeyBody.parse(req.body ?? {});
    const r = createKey(gw.db, { tenantId, name: body.name, scopes: body.scopes, expiresInDays: body.expiresInDays, createdBy: req.user!.id });
    if ("error" in r) {
      throw new GatewayError(409, "key_limit_reached", `A tenant can have at most ${MAX_ACTIVE_KEYS_PER_TENANT} active keys. Revoke one first.`);
    }
    audit(gw.db, { tenantId, actor: req.user!, action: "key.create", target: r.key.id, ip: req.ip, meta: { name: body.name, scopes: body.scopes, expiresInDays: body.expiresInDays } });
    // the only response that ever carries the plaintext secret
    res.status(201).json({ key: r.key, secret: r.secret });
  });

  app.delete("/api/console/keys/:id", session, csrf, need("keys:revoke_own"), (req, res) => {
    const id = String(req.params.id);
    const k = /^key_[a-z0-9_]{1,40}$/.test(id) ? getKey(gw.db, id) : null;
    if (!k || (!isOperator(req) && k.tenantId !== req.user!.tenantId)) throw new GatewayError(404, "not_found", "API key not found.");
    if (!can(req.user!.role, "keys:revoke_any") && k.createdBy !== req.user!.id) {
      throw new GatewayError(403, "forbidden", "You can only revoke keys you created.");
    }
    revokeKey(gw.db, id);
    audit(gw.db, { tenantId: k.tenantId, actor: req.user!, action: "key.revoke", target: id, ip: req.ip, meta: { name: k.name } });
    res.json({ key: getKey(gw.db, id) });
  });

  app.get("/api/console/audit", session, need("audit:read"), (req, res) => {
    res.json(listAudit(gw.db, scopeTenant(req, true), 100));
  });

  // ---------- governance: guardrails, members ----------
  app.get("/api/console/governance", session, need("governance:read"), (req, res) => {
    const tenantId = scopeTenant(req, false)!;
    const t = getTenant(gw.db, tenantId)!;
    const since = Date.now() - 30 * 86_400_000;
    const rows = gw.db
      .prepare("SELECT pii, outcome, error_code FROM requests WHERE tenant_id = ? AND created_at >= ? AND pii IS NOT NULL")
      .all(tenantId, since) as { pii: string; error_code: string | null }[];
    const byType: Record<string, number> = {};
    for (const r of rows) for (const part of r.pii.split(",")) {
      const [k, n] = part.split(":");
      byType[k] = (byType[k] ?? 0) + Number(n || 0);
    }
    const total = (gw.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE tenant_id = ? AND created_at >= ?").get(tenantId, since) as { n: number }).n;
    res.json({
      tenant: { id: t.id, name: t.name },
      piiPolicy: t.piiPolicy,
      piiTypes: PII_TYPES.map((id) => ({ id, label: PII_LABEL[id] })),
      stats: {
        windowDays: 30,
        requests: total,
        requestsWithPii: rows.length,
        blocked: rows.filter((r) => r.error_code === "pii_detected").length,
        byType,
      },
      canEdit: can(req.user!.role, "governance:write"),
    });
  });

  app.put("/api/console/governance/pii", session, csrf, need("governance:write"), (req, res) => {
    const tenantId = scopeTenant(req, false)!;
    const body = PiiPolicyBody.parse(req.body ?? {});
    if (body.mode !== "off" && body.types.length === 0) {
      throw new GatewayError(400, "invalid_request", "Pick at least one type of personal data, or turn the guardrail off.");
    }
    const before = getTenant(gw.db, tenantId)!.piiPolicy;
    setPiiPolicy(gw.db, tenantId, { mode: body.mode, types: [...new Set(body.types)] });
    audit(gw.db, { tenantId, actor: req.user!, action: "governance.pii_policy", target: tenantId, ip: req.ip, meta: { from: before.mode, to: body.mode, types: body.types } });
    res.json({ piiPolicy: getTenant(gw.db, tenantId)!.piiPolicy });
  });

  // a dry run of the detector: nothing is stored or sent to a model
  app.post("/api/console/governance/pii/test", session, csrf, need("governance:read"), (req, res) => {
    const { text } = PiiTestBody.parse(req.body ?? {});
    const tenantId = scopeTenant(req, false)!;
    const s = scanPii(text, getTenant(gw.db, tenantId)!.piiPolicy.types);
    res.json({ masked: s.masked, findings: s.findings.map((f) => ({ type: f.type, label: PII_LABEL[f.type], placeholder: `{{${f.slot}}}` })) });
  });

  app.get("/api/console/members", session, need("members:read"), (req, res) => {
    const tenantId = scopeTenant(req, true);
    const rows = (tenantId
      ? gw.db.prepare("SELECT id, tenant_id, email, name, role, created_at, last_login_at, disabled_at FROM users WHERE tenant_id = ? ORDER BY role, email").all(tenantId)
      : gw.db.prepare("SELECT id, tenant_id, email, name, role, created_at, last_login_at, disabled_at FROM users ORDER BY tenant_id, role, email").all()) as any[];
    res.json(rows.map((u) => ({ id: u.id, tenantId: u.tenant_id, email: u.email, name: u.name, role: u.role, createdAt: u.created_at, lastLoginAt: u.last_login_at, disabled: !!u.disabled_at })));
  });

  // ---------- playground: the same two endpoints an API key calls, as the signed-in user's tenant ----------
  const playground = (endpoint: "support.answer" | "chat.completions", spec: typeof supportSpec) =>
    async (req: Request, res: Response) => {
      const { tenant: asked, ...rest } = PlaygroundBody.parse(req.body ?? {});
      let tenantId = req.user!.tenantId;
      if (asked && asked !== tenantId) {
        if (!isOperator(req)) throw new GatewayError(404, "not_found", "Tenant not found.");
        if (!ID.test(asked) || !getTenant(gw.db, asked)) throw new GatewayError(404, "not_found", "Tenant not found.");
        tenantId = asked;
      }
      const tenant = getTenant(gw.db, tenantId)!;
      await runCapability(req, res, endpoint, { tenant, credential: `user:${req.user!.id}` }, spec(gw, res, rest));
    };
  app.post("/api/console/playground/support", session, csrf, need("playground:run"), playground("support.answer", supportSpec));
  app.post("/api/console/playground/chat", session, csrf, need("playground:run"), playground("chat.completions", chatSpec));
}
