/**
 * Console API controller: session sign-in, RBAC, tenant scoping and API key management.
 * Each handler parses the request, checks the permission, calls a use case and sends its result;
 * the rules themselves (scoping, redaction, lockout, revoke rights) live in use-cases/.
 *
 * Rules every route here follows:
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
import { EXPIRY_DAYS, KEY_SCOPES, MAX_ACTIVE_KEYS_PER_TENANT } from "../../../entities/auth/apiKey.js";
import { can, GRANTS, type Permission } from "../../../entities/auth/rbac.js";
import { SESSION_MAX_MS, type User } from "../../../entities/auth/user.js";
import { GatewayError } from "../../../entities/errors.js";
import { PII_MODES, PII_TYPES } from "../../../entities/guardrails/pii.js";
import { LIMITS } from "../../../entities/limits.js";
import { CONFIDENCE_WEIGHTS } from "../../../entities/support/confidence.js";
import type { Tenant } from "../../../entities/types.js";
import { isOperator, playgroundTenant, scopeTenant } from "../../../use-cases/access.js";
import { createApiKey, listApiKeys, revokeApiKey } from "../../../use-cases/apiKeys.js";
import type { GatewayDeps } from "../../../use-cases/deps.js";
import { listDemoAccounts, resolveSession, signIn, signOut } from "../../../use-cases/identity.js";
import { auditTrail, dashboardMetrics, requestDetailFor, requestLog } from "../../../use-cases/observability.js";
import { backendStatusFor, clearFaultInjection, evalRuns, setFaultInjection } from "../../../use-cases/operations.js";
import {
  governanceReport,
  listMembers,
  quotaOverview,
  resetTenantQuota,
  testPiiPolicy,
  updatePiiPolicy,
} from "../../../use-cases/tenants.js";
import { actorOf, askedTenant } from "./request.js";
import { clearSessionCookie, readCookie, safeEq, sameOrigin, sessionCookieName, setSessionCookie } from "./security.js";
import type { HttpSettings } from "./settings.js";
import { ChaosBody } from "./shared.js";
import { chatSpec, parseBody, supportSpec, type RunCapability } from "./specs.js";

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
    expiresInDays: z.union([
      z.literal(EXPIRY_DAYS[0]),
      z.literal(EXPIRY_DAYS[1]),
      z.literal(EXPIRY_DAYS[2]),
      z.literal(EXPIRY_DAYS[3]),
      z.null(),
    ]),
  })
  .strict();

const PlaygroundBody = z.object({ tenant: z.string().max(64).optional() }).passthrough();
const PiiPolicyBody = z
  .object({ mode: z.enum(PII_MODES), types: z.array(z.enum(PII_TYPES)).max(PII_TYPES.length) })
  .strict();
const PiiTestBody = z.object({ text: z.string().max(2000, "text is at most 2000 characters") }).strict();

/** the signed-in user as the console sees it */
const publicUser = (u: User, t: Tenant | null) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  tenant: t ? { id: t.id, name: t.name, plan: t.plan } : null,
  permissions: GRANTS[u.role],
});

export function mountConsole(app: Express, deps: GatewayDeps, cfg: HttpSettings, runCapability: RunCapability) {
  // ---------- middleware ----------
  const session = (req: Request, _res: Response, next: NextFunction) => {
    const s = resolveSession(deps, readCookie(req, sessionCookieName(req, cfg)));
    req.user = s.user;
    req.csrf = s.csrf;
    next();
  };
  /** state-changing requests: same origin, and the per-session CSRF token in a header */
  const csrf = (req: Request, _res: Response, next: NextFunction) => {
    const sent = req.header("x-csrf-token") ?? "";
    if (!sameOrigin(req) || !req.csrf || !safeEq(sent, req.csrf)) {
      return next(
        new GatewayError(403, "csrf_failed", "Your session could not be verified. Reload the page and try again."),
      );
    }
    next();
  };
  const need = (p: Permission) => (req: Request, _res: Response, next: NextFunction) =>
    can(req.user!.role, p) ? next() : next(new GatewayError(403, "forbidden", "You don't have permission to do that."));
  /** the tenant this request is about: see scopeTenant */
  const scoped = (req: Request) => scopeTenant(deps, req.user!, askedTenant(req), true);
  const ownScoped = (req: Request) => scopeTenant(deps, req.user!, askedTenant(req), false);

  // ---------- auth ----------
  app.post("/api/auth/login", async (req, res) => {
    if (!sameOrigin(req)) throw new GatewayError(403, "csrf_failed", "Sign-in must come from the console.");
    const parsed = LoginBody.safeParse(req.body ?? {});
    // one message for every bad input: don't coach a guesser on the format
    if (!parsed.success) throw new GatewayError(400, "invalid_request", "Enter your email address and password.");
    const signedIn = await signIn(deps, {
      ...parsed.data,
      ip: req.ip ?? "unknown",
      userAgent: req.header("user-agent"),
    });
    setSessionCookie(req, res, cfg, signedIn.token, SESSION_MAX_MS);
    res.json({ user: publicUser(signedIn.user, signedIn.tenant), csrfToken: signedIn.csrf });
  });

  app.post("/api/auth/logout", session, csrf, (req, res) => {
    signOut(deps, actorOf(req), readCookie(req, sessionCookieName(req, cfg)));
    clearSessionCookie(req, res, cfg);
    res.status(204).end();
  });

  app.get("/api/auth/session", session, (req, res) => {
    res.json({ user: publicUser(req.user!, deps.tenants.get(req.user!.tenantId)), csrfToken: req.csrf });
  });

  // demo convenience for reviewers: the four seeded accounts. Off unless DEMO_MODE=true.
  app.get("/api/auth/demo-accounts", (_req, res) => {
    res.json(listDemoAccounts(deps, cfg.demoMode));
  });

  // ---------- console data ----------
  app.get("/api/console/config", session, (req, res) => {
    const tenants = isOperator(req.user!) ? deps.tenants.list() : [deps.tenants.get(req.user!.tenantId)!];
    res.json({
      tenants: tenants.map((t) => ({
        id: t.id,
        name: t.name,
        plan: t.plan,
        allowedTiers: t.allowedTiers,
        profile: t.profile,
        piiMode: t.piiPolicy.mode,
      })),
      backends: deps.backends.map((b) => ({
        id: b.config.id,
        tier: b.config.tier,
        model: b.config.model,
        location: b.config.location,
        enabled: b.config.enabled,
        contextWindow: b.config.contextWindow ?? null,
      })),
      // what the playground explains: how many KB entries the model sees, and how confidence is weighed
      support: { contextK: deps.config.support.contextK, confidenceWeights: CONFIDENCE_WEIGHTS },
      // the playground validates against the same limits the API enforces
      limits: {
        ...LIMITS,
        supportAnswerTokens: deps.config.support.maxAnswerTokens,
        supportReasoningExtraTokens: deps.config.support.reasoningExtraTokens,
      },
      intents: deps.intents,
      keyScopes: KEY_SCOPES,
      keyExpiryDays: EXPIRY_DAYS,
      maxActiveKeys: MAX_ACTIVE_KEYS_PER_TENANT,
    });
  });

  app.get("/api/console/metrics", session, need("dashboard:read"), (req, res) => {
    const backend = typeof req.query.backend === "string" && req.query.backend ? req.query.backend : undefined;
    res.json(dashboardMetrics(deps, String(req.query.range ?? "24h"), { tenantId: scoped(req) ?? undefined, backend }));
  });

  app.get("/api/console/requests", session, need("requests:read"), (req, res) => {
    res.json(requestLog(deps, req.user!, { tenantId: scoped(req) ?? undefined, limit: Number(req.query.limit) || 50 }));
  });

  app.get("/api/console/requests/:id", session, need("requests:read"), (req, res) => {
    res.json(requestDetailFor(deps, actorOf(req), String(req.params.id)));
  });

  app.get("/api/console/usage", session, need("usage:read"), (req, res) => {
    res.json(quotaOverview(deps, scoped(req)));
  });

  app.post("/api/console/tenants/:id/reset-quota", session, csrf, need("quota:reset"), (req, res) => {
    res.json(resetTenantQuota(deps, String(req.params.id), actorOf(req)));
  });

  app.get("/api/console/backends", session, need("backends:read"), (req, res) => {
    res.json(backendStatusFor(deps, req.user!));
  });

  app.put("/api/console/chaos/:backend", session, csrf, need("chaos:write"), (req, res) => {
    const id = String(req.params.backend);
    // an unknown backend is a 404 before the body is looked at
    if (!deps.backends.some((b) => b.config.id === id)) throw new GatewayError(404, "not_found", "Backend not found.");
    res.json(setFaultInjection(deps, actorOf(req), id, parseBody(ChaosBody, req.body)));
  });

  app.delete("/api/console/chaos", session, csrf, need("chaos:write"), (req, res) => {
    res.json(clearFaultInjection(deps, actorOf(req)));
  });

  app.get("/api/console/evals", session, need("evals:read"), (_req, res) => {
    res.json(evalRuns(deps));
  });

  // ---------- API keys ----------
  app.get("/api/console/keys", session, need("keys:read"), (req, res) => {
    res.json(listApiKeys(deps, ownScoped(req)));
  });

  app.post("/api/console/keys", session, csrf, need("keys:create"), (req, res) => {
    const tenantId = ownScoped(req);
    const body = parseBody(KeyBody, req.body);
    // the only response that ever carries the plaintext secret
    res.status(201).json(createApiKey(deps, actorOf(req), tenantId, body));
  });

  app.delete("/api/console/keys/:id", session, csrf, need("keys:revoke_own"), (req, res) => {
    res.json(revokeApiKey(deps, actorOf(req), String(req.params.id)));
  });

  app.get("/api/console/audit", session, need("audit:read"), (req, res) => {
    res.json(auditTrail(deps, scoped(req)));
  });

  // ---------- governance: guardrails, members ----------
  app.get("/api/console/governance", session, need("governance:read"), (req, res) => {
    res.json(governanceReport(deps, req.user!, ownScoped(req)));
  });

  app.put("/api/console/governance/pii", session, csrf, need("governance:write"), (req, res) => {
    const tenantId = ownScoped(req);
    res.json(updatePiiPolicy(deps, actorOf(req), tenantId, parseBody(PiiPolicyBody, req.body)));
  });

  // a dry run of the detector: nothing is stored or sent to a model
  app.post("/api/console/governance/pii/test", session, csrf, need("governance:read"), (req, res) => {
    const { text } = parseBody(PiiTestBody, req.body);
    res.json(testPiiPolicy(deps, ownScoped(req), text));
  });

  app.get("/api/console/members", session, need("members:read"), (req, res) => {
    res.json(listMembers(deps, scoped(req)));
  });

  // ---------- playground: the same two endpoints an API key calls, as the signed-in user's tenant ----------
  const playground =
    (endpoint: "support.answer" | "chat.completions", spec: typeof supportSpec) =>
    async (req: Request, res: Response) => {
      const { tenant: asked, ...rest } = parseBody(PlaygroundBody, req.body);
      const tenant = playgroundTenant(deps, req.user!, asked);
      await runCapability(req, res, endpoint, { tenant, credential: `user:${req.user!.id}` }, spec(deps, res, rest));
    };
  app.post(
    "/api/console/playground/support",
    session,
    csrf,
    need("playground:run"),
    playground("support.answer", supportSpec),
  );
  app.post(
    "/api/console/playground/chat",
    session,
    csrf,
    need("playground:run"),
    playground("chat.completions", chatSpec),
  );
}
