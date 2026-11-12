/** The ConsoleApi port over HTTP: every console endpoint, in one place. */
import type { ConsoleApi } from "../../../use-cases/ports";
import type { DemoAccount, SessionUser } from "../../../entities/models";
import { call, qs, request, setCsrf, setSignedOutHandler, toError } from "./client";
import { runPlaygroundRequest } from "./playgroundStream";

const enc = encodeURIComponent;

export function createHttpConsoleApi(): ConsoleApi {
  return {
    auth: {
      async signIn(email, password) {
        const r = await call<{ user: SessionUser; csrfToken: string }>("/api/auth/login", { method: "POST", json: { email, password } });
        setCsrf(r.csrfToken);
        return r.user;
      },
      async session() {
        const res = await request("/api/auth/session");
        if (res.status === 401) return null;
        if (!res.ok) throw await toError(res);
        const r = await res.json();
        setCsrf(r.csrfToken);
        return r.user;
      },
      async signOut() {
        await call("/api/auth/logout", { method: "POST" }).catch(() => {}); // signing out locally is enough if the call fails
        setCsrf("");
      },
      async demoAccounts() {
        const r = await fetch("/api/auth/demo-accounts");
        return r.ok ? ((await r.json()) as DemoAccount[]) : [];
      },
      onSignedOut: setSignedOutHandler,
    },
    config: () => call("/api/console/config"),
    metrics: ({ range, tenant, backend }) => call(`/api/console/metrics${qs({ range, tenant, backend })}`),
    usage: (tenant) => call(`/api/console/usage${qs({ tenant })}`),
    resetQuota: async (id) => void (await call(`/api/console/tenants/${enc(id)}/reset-quota`, { method: "POST" })),
    backends: () => call("/api/console/backends"),
    setChaos: async (id, patch) => void (await call(`/api/console/chaos/${enc(id)}`, { method: "PUT", json: patch })),
    clearChaos: async () => void (await call("/api/console/chaos", { method: "DELETE" })),
    requests: ({ limit, tenant }) => call(`/api/console/requests${qs({ limit, tenant })}`),
    request: (id) => call(`/api/console/requests/${enc(id)}`),
    keys: async (tenant) => (await call<{ keys: any[] }>(`/api/console/keys${qs({ tenant })}`)).keys,
    createKey: (tenant, body) => call(`/api/console/keys${qs({ tenant })}`, { method: "POST", json: body }),
    revokeKey: async (id, tenant) => void (await call(`/api/console/keys/${enc(id)}${qs({ tenant })}`, { method: "DELETE" })),
    audit: (tenant) => call(`/api/console/audit${qs({ tenant })}`),
    members: (tenant) => call(`/api/console/members${qs({ tenant })}`),
    governance: (tenant) => call(`/api/console/governance${qs({ tenant })}`),
    setPiiPolicy: async (tenant, policy) => void (await call(`/api/console/governance/pii${qs({ tenant })}`, { method: "PUT", json: policy })),
    testPii: (tenant, text) => call(`/api/console/governance/pii/test${qs({ tenant })}`, { method: "POST", json: { text } }),
    evals: () => call("/api/console/evals"),
    playground: (endpoint, body, stream, h, signal) => runPlaygroundRequest(endpoint, body, stream, h.onEvent, h.onRaw, signal),
  };
}
