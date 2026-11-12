/** Console sign-in, sessions, CSRF, RBAC, tenant isolation and API key lifecycle. */
import { afterEach, describe, expect, it } from "vitest";
import { FakeBackend, cfg, reply, signIn, startServer } from "./helpers.js";
import { hashPassword, verifyPassword } from "../src/interface-adapters/gateways/crypto/passwords.js";
import { can } from "../src/entities/auth/rbac.js";

const GOOD = '{"intent":"cancel_order","confidence":0.9}\n###\nGo to Orders and press Cancel.';
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});
const server = async (over: Parameters<typeof startServer>[1] = {}) => {
  const s = await startServer([new FakeBackend(cfg("f", "fast"), reply(GOOD))], over);
  close = s.close;
  return s;
};
const login = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("passwords", () => {
  it("hashes with a per-hash salt and verifies", async () => {
    const a = await hashPassword("correct horse");
    const b = await hashPassword("correct horse");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("correct horsE", a)).toBe(false);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });
});

describe("sign-in", () => {
  it("issues an HttpOnly SameSite=Strict session cookie and a CSRF token", async () => {
    const s = await server();
    const res = await login(s.base, { email: "Owner@Test.example", password: "owner-pass-1" });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const body = await res.json();
    expect(body.user).toMatchObject({ email: "owner@test.example", role: "owner", tenant: { id: "pro" } });
    expect(body.user.permissions).toContain("keys:create");
    expect(body.csrfToken).toMatch(/^[\w-]{20,}$/);
    expect(JSON.stringify(body)).not.toMatch(/password|hash/i);
  });

  it("returns one generic error for a wrong password and for an unknown account", async () => {
    const s = await server();
    const wrong = await login(s.base, { email: "owner@test.example", password: "nope" });
    const unknown = await login(s.base, { email: "ghost@test.example", password: "nope" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    const bad = await login(s.base, { email: "not-an-email", password: "" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toBe("Enter your email address and password.");
    expect((await login(s.base, { email: "owner@test.example", password: "owner-pass-1", extra: 1 })).status).toBe(400);
  });

  it("locks an account after repeated failures without saying whether it exists", async () => {
    const s = await server({ auth: { maxFailuresPerAccount: 3 } });
    for (let i = 0; i < 3; i++)
      expect((await login(s.base, { email: "dev@test.example", password: "bad" })).status).toBe(401);
    const locked = await login(s.base, { email: "dev@test.example", password: "dev-pass-1" });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await locked.json()).error.code).toBe("too_many_attempts");
    // other accounts are unaffected
    expect((await login(s.base, { email: "owner@test.example", password: "owner-pass-1" })).status).toBe(200);
  });

  it("rejects a cross-origin sign-in", async () => {
    const s = await server();
    const res = await login(
      s.base,
      { email: "owner@test.example", password: "owner-pass-1" },
      { origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
  });

  it("requires a session, and logout ends it", async () => {
    const s = await server();
    expect((await fetch(`${s.base}/api/console/metrics?range=1h`)).status).toBe(401);
    const { call } = await signIn(s.base, "owner@test.example", "owner-pass-1");
    expect((await call("/api/auth/session")).status).toBe(200);
    expect((await call("/api/auth/logout", { method: "POST" })).status).toBe(204);
    expect((await call("/api/auth/session")).status).toBe(401);
  });

  it("exposes the demo accounts only in demo mode", async () => {
    const off = await server({ demoMode: false });
    expect((await fetch(`${off.base}/api/auth/demo-accounts`)).status).toBe(404);
  });
});

describe("CSRF", () => {
  it("refuses state-changing calls without the session's token or from another origin", async () => {
    const s = await server();
    const { call } = await signIn(s.base, "owner@test.example", "owner-pass-1");
    const body = { name: "ci", scopes: ["support.answer"], expiresInDays: 30 };
    expect((await call("/api/console/keys", { method: "POST", json: body, noCsrf: true })).status).toBe(403);
    expect(
      (await call("/api/console/keys", { method: "POST", json: body, headers: { "x-csrf-token": "forged" } })).status,
    ).toBe(403);
    expect(
      (await call("/api/console/keys", { method: "POST", json: body, headers: { origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
    expect((await call("/api/console/keys", { method: "POST", json: body })).status).toBe(201);
  });
});

describe("RBAC", () => {
  it("grants match the documented matrix", () => {
    expect(can("viewer", "playground:run")).toBe(false);
    expect(can("viewer", "keys:read")).toBe(false);
    expect(can("developer", "keys:revoke_any")).toBe(false);
    expect(can("owner", "chaos:write")).toBe(false);
    expect(can("owner", "keys:revoke_any")).toBe(true);
    expect(can("operator", "chaos:write")).toBe(true);
  });

  it("a viewer reads dashboards but can't run the playground, see keys or inject faults", async () => {
    const s = await server();
    const { call } = await signIn(s.base, "viewer@test.example", "viewer-pass-1");
    expect((await call("/api/console/metrics?range=1h")).status).toBe(200);
    const pg = await call("/api/console/playground/support", {
      method: "POST",
      json: { message: "cancel my order", stream: false },
    });
    expect(pg.status).toBe(403);
    const pgChat = await call("/api/console/playground/chat", {
      method: "POST",
      json: { messages: [{ role: "user", content: "hi" }], stream: false },
    });
    expect(pgChat.status).toBe(403);
    expect((await pg.json()).error).toEqual({ code: "forbidden", message: "You don't have permission to do that." });
    expect((await call("/api/console/keys")).status).toBe(403);
    expect((await call("/api/console/chaos/f", { method: "PUT", json: { failRate: 1 } })).status).toBe(403);
  });

  it("pins non-operators to their own tenant", async () => {
    const s = await server();
    // a request made by tenant "pro"
    await fetch(`${s.base}/v1/support/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k-pro" },
      body: JSON.stringify({ message: "how do I cancel my order", stream: false }),
    });
    const proReq = (s.gw.db.prepare("SELECT id FROM requests WHERE tenant_id = 'pro'").get() as any).id;
    const viewer = await signIn(s.base, "viewer@test.example", "viewer-pass-1"); // tenant "free"
    // asking for another tenant is silently scoped back to your own
    const list = await (await viewer.call("/api/console/requests?tenant=pro")).json();
    expect(list.every((r: any) => r.tenant_id === "free")).toBe(true);
    const usage = await (await viewer.call("/api/console/usage")).json();
    expect(usage.map((u: any) => u.tenant)).toEqual(["free"]);
    // another tenant's request id looks exactly like a missing one
    const other = await viewer.call(`/api/console/requests/${proReq}`);
    const missing = await viewer.call("/api/console/requests/req_doesnotexist");
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
    // the operator sees everyone
    const op = await signIn(s.base, "op@test.example", "op-pass-1");
    expect((await op.call(`/api/console/requests/${proReq}`)).status).toBe(200);
    expect((await (await op.call("/api/console/usage")).json()).length).toBe(3);
  });

  it("hides provider error text and fault settings from tenant users", async () => {
    const s = await server();
    const owner = await signIn(s.base, "owner@test.example", "owner-pass-1");
    const b = (await (await owner.call("/api/console/backends")).json())[0];
    expect(b).not.toHaveProperty("chaos");
    expect(b.breaker).toEqual({ state: "closed" });
    const op = await signIn(s.base, "op@test.example", "op-pass-1");
    expect((await (await op.call("/api/console/backends")).json())[0]).toHaveProperty("chaos");
  });
});

describe("console quotas", () => {
  it("flags a tenant as rejecting once its newest request was refused for quota", async () => {
    const s = await server();
    const { call } = await signIn(s.base, "op@test.example", "op-pass-1");
    const tiny = async () =>
      ((await (await call("/api/console/usage")).json()) as any[]).find((u) => u.tenant === "tiny");
    expect(await tiny()).toMatchObject({ quotaRejections: 0, rejecting: false });
    for (let i = 0; i < 3; i++) {
      await fetch(`${s.base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer k-tiny", "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
    }
    expect(await tiny()).toMatchObject({ requestsUsed: 2, quotaRejections: 1, rejecting: true });
    await call("/api/console/tenants/tiny/reset-quota", { method: "POST" });
    expect(await tiny()).toMatchObject({ requestsUsed: 0, quotaRejections: 0, rejecting: false });
  });
});

describe("console playground", () => {
  it("runs the support pipeline as the user's tenant and meters it against that tenant", async () => {
    const s = await server();
    const { call } = await signIn(s.base, "dev@test.example", "dev-pass-1");
    const r = await (
      await call("/api/console/playground/support", {
        method: "POST",
        json: { message: "how do I cancel my order", stream: false },
      })
    ).json();
    expect(r.outcome).toBe("success");
    const row = s.gw.db.prepare("SELECT tenant_id, credential FROM requests WHERE id = ?").get(r.requestId) as any;
    expect(row).toEqual({ tenant_id: "pro", credential: "user:u_dev" });
    // only operators may act as another tenant
    const asOther = await call("/api/console/playground/support", {
      method: "POST",
      json: { message: "x", tenant: "free", stream: false },
    });
    expect(asOther.status).toBe(404);
  });

  it("runs chat completions as the user's tenant, as JSON or as an OpenAI-style stream", async () => {
    const s = await server();
    const { call } = await signIn(s.base, "dev@test.example", "dev-pass-1");
    const messages = [{ role: "user", content: "hi" }];
    const j = await (
      await call("/api/console/playground/chat", { method: "POST", json: { messages, stream: false } })
    ).json();
    expect(j.object).toBe("chat.completion");
    expect(j.choices[0].message.role).toBe("assistant");
    expect(j.x_router.outcome).toBe("success");
    const row = s.gw.db.prepare("SELECT tenant_id, endpoint, credential FROM requests WHERE id = ?").get(j.id) as any;
    expect(row).toEqual({ tenant_id: "pro", endpoint: "chat.completions", credential: "user:u_dev" });

    const res = await call("/api/console/playground/chat", { method: "POST", json: { messages, stream: true } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toMatch(/^: route \{.*"t":\d+/m); // trace comments carry the server-side elapsed time
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);

    const asOther = await call("/api/console/playground/chat", {
      method: "POST",
      json: { messages, tenant: "free", stream: false },
    });
    expect(asOther.status).toBe(404);
    const bad = await call("/api/console/playground/chat", {
      method: "POST",
      json: { messages: [{ role: "robot", content: "hi" }] },
    });
    expect(bad.status).toBe(400);
  });
});

describe("API keys", () => {
  const create = (call: any, body: object = {}) =>
    call("/api/console/keys", {
      method: "POST",
      json: { name: "Production backend", scopes: ["support.answer"], expiresInDays: 90, ...body },
    });

  it("shows the secret once, stores only a digest, and the key works with its scopes", async () => {
    const s = await server();
    const { call } = await signIn(s.base, "dev@test.example", "dev-pass-1");
    const res = await create(call);
    expect(res.status).toBe(201);
    const { key, secret } = await res.json();
    expect(secret).toMatch(/^nr_live_[\w-]{32}$/);
    expect(key).toMatchObject({
      name: "Production backend",
      scopes: ["support.answer"],
      status: "active",
      last4: secret.slice(-4),
    });
    expect(key.expiresAt).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    // never again in plaintext: not in the list, not in the database
    const list = await (await call("/api/console/keys")).json();
    expect(JSON.stringify(list)).not.toContain(secret);
    const row = s.gw.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(key.id) as any;
    expect(JSON.stringify(row)).not.toContain(secret);

    const auth = { "content-type": "application/json", authorization: `Bearer ${secret}` };
    const ok = await fetch(`${s.base}/v1/support/answer`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ message: "how do I cancel my order", stream: false }),
    });
    expect(ok.status).toBe(200);
    const req = s.gw.db.prepare("SELECT credential FROM requests WHERE id = ?").get((await ok.json()).requestId) as any;
    expect(req.credential).toBe(key.id);
    // least privilege: this key has no chat scope
    const chat = await fetch(`${s.base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(chat.status).toBe(403);
    expect((await chat.json()).error.code).toBe("insufficient_scope");
  });

  it("validates input", async () => {
    const s = await server();
    const { call } = await signIn(s.base, "owner@test.example", "owner-pass-1");
    expect((await create(call, { name: "" })).status).toBe(400);
    expect((await create(call, { name: "<script>" })).status).toBe(400);
    expect((await create(call, { scopes: [] })).status).toBe(400);
    expect((await create(call, { scopes: ["admin"] })).status).toBe(400);
    expect((await create(call, { scopes: ["usage.read", "usage.read"] })).status).toBe(400);
    expect((await create(call, { expiresInDays: 9999 })).status).toBe(400);
    expect((await create(call, { tenantId: "free" })).status).toBe(400);
    expect((await create(call, { expiresInDays: null })).status).toBe(201);
  });

  it("revoked keys fail exactly like unknown keys", async () => {
    const s = await server();
    const { call } = await signIn(s.base, "owner@test.example", "owner-pass-1");
    const { key, secret } = await (await create(call)).json();
    expect((await call(`/api/console/keys/${key.id}`, { method: "DELETE" })).status).toBe(200);
    const send = (k: string) =>
      fetch(`${s.base}/v1/support/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${k}` },
        body: JSON.stringify({ message: "x" }),
      });
    const revoked = await send(secret);
    const unknown = await send("nr_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual(await unknown.json());
  });

  it("developers revoke only their own keys; owners revoke any key in their tenant", async () => {
    const s = await server();
    const dev = await signIn(s.base, "dev@test.example", "dev-pass-1");
    const dev2 = await signIn(s.base, "dev2@test.example", "dev2-pass-1");
    const owner = await signIn(s.base, "owner@test.example", "owner-pass-1");
    const { key } = await (await create(dev.call)).json();
    const denied = await dev2.call(`/api/console/keys/${key.id}`, { method: "DELETE" });
    expect(denied.status).toBe(403);
    expect((await owner.call(`/api/console/keys/${key.id}`, { method: "DELETE" })).status).toBe(200);
    // and nobody outside the tenant can see that the key exists
    const op = await signIn(s.base, "viewer@test.example", "viewer-pass-1");
    expect((await op.call(`/api/console/keys/${key.id}`, { method: "DELETE" })).status).toBe(403); // viewers lack the permission entirely
    const audit = await (await owner.call("/api/console/audit")).json();
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(["key.create", "key.revoke", "auth.login"]));
  });

  it("caps active keys per tenant", async () => {
    const s = await server();
    const { call } = await signIn(s.base, "owner@test.example", "owner-pass-1");
    const active = (
      s.gw.db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id='pro' AND revoked_at IS NULL").get() as any
    ).n;
    for (let i = active; i < 10; i++) expect((await create(call, { name: `k${i}` })).status).toBe(201);
    const over = await create(call, { name: "one too many" });
    expect(over.status).toBe(409);
    expect((await over.json()).error.code).toBe("key_limit_reached");
  });
});

describe("error hygiene", () => {
  it("doesn't echo paths and sets security headers", async () => {
    const s = await server();
    const res = await fetch(`${s.base}/v1/<script>alert(1)</script>`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found." } });
    expect(res.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
