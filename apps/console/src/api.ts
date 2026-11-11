/**
 * Console API client. Authentication is a session cookie (HttpOnly, so this code never sees it)
 * plus a per-session CSRF token sent on every state-changing request. The console holds no
 * tenant API key and no admin token.
 */
export type Role = "operator" | "owner" | "developer" | "viewer";
export type Permission =
  | "dashboard:read" | "requests:read" | "usage:read" | "evals:read" | "backends:read" | "playground:run"
  | "keys:read" | "keys:create" | "keys:revoke_own" | "keys:revoke_any" | "audit:read" | "tenants:all" | "quota:reset" | "chaos:write"
  | "governance:read" | "governance:write" | "members:read";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenant: { id: string; name: string; plan: string } | null;
  permissions: Permission[];
}

export interface ConsoleTenant {
  id: string;
  name: string;
  plan: string;
  allowedTiers: string[];
  /** company facts the gateway uses to fill {{…}} placeholders */
  profile: Record<string, string>;
}
export interface ConsoleConfig {
  tenants: ConsoleTenant[];
  backends: { id: string; tier: string; model: string; location: string; enabled: boolean }[];
  intents: string[];
  keyScopes: string[];
  keyExpiryDays: number[];
  maxActiveKeys: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let csrfToken = "";
export const setCsrf = (t: string) => (csrfToken = t);
/** called when any request finds the session gone, so the shell can show the sign-in page */
let onSignedOut: () => void = () => {};
export const setSignedOutHandler = (f: () => void) => (onSignedOut = f);

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function request(path: string, init: RequestInit = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(MUTATING.has(method) && csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401 && !path.startsWith("/api/auth/")) onSignedOut();
  return res;
}

async function toError(res: Response) {
  const j = await res.json().catch(() => ({}));
  // the server already keeps messages short and safe; fall back to a generic line for anything odd
  return new ApiError(res.status, j?.error?.code ?? "http_error", j?.error?.message ?? "Something went wrong. Try again.", j?.error?.details);
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await request(path, json !== undefined ? { ...rest, body: JSON.stringify(json) } : rest);
  if (!res.ok) throw await toError(res);
  return (res.status === 204 ? null : await res.json()) as T;
}

// ---------- auth ----------
export async function signIn(email: string, password: string) {
  const r = await api<{ user: SessionUser; csrfToken: string }>("/api/auth/login", { method: "POST", json: { email, password } });
  setCsrf(r.csrfToken);
  return r.user;
}
export async function currentSession(): Promise<SessionUser | null> {
  const res = await request("/api/auth/session");
  if (res.status === 401) return null;
  if (!res.ok) throw await toError(res);
  const r = await res.json();
  setCsrf(r.csrfToken);
  return r.user;
}
export async function signOut() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  setCsrf("");
}
export interface DemoAccount {
  email: string;
  role: Role;
  tenant: string;
  password: string | null;
}
export async function demoAccounts(): Promise<DemoAccount[]> {
  const r = await fetch("/api/auth/demo-accounts");
  return r.ok ? r.json() : [];
}

/** POST + parse a Server-Sent-Events body (EventSource can't POST). */
export async function streamPlayground(
  body: { message: string; model?: string; prompt_version?: string; include_reasoning?: boolean; tenant?: string },
  onEvent: (event: string, data: any) => void,
  signal?: AbortSignal,
) {
  const res = await request("/api/console/playground/support", { method: "POST", body: JSON.stringify({ ...body, stream: true }), signal });
  if (!res.ok) throw await toError(res);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent(ev, JSON.parse(data));
    }
  }
}

export interface BackendStatus {
  id: string;
  tier: string;
  model: string;
  enabled: boolean;
  location: string;
  health?: { label: "online" | "offline"; availability: string; reason?: string; checkedAt: number | null; probeLatencyMs?: number | null };
  breaker: { state: string; reopensInMs?: number; lastError?: string | null; consecutiveFailures?: number };
  chaos?: { failRate: number; mode: string; addedLatencyMs: number };
  [k: string]: any;
}

export interface ApiKey {
  id: string;
  tenantId: string;
  name: string;
  prefix: string;
  last4: string;
  scopes: string[];
  createdBy: string | null;
  createdByEmail: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  status: "active" | "expired" | "revoked";
}

export const fmtUsd = (x: number | null | undefined) =>
  x == null ? "–" : x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(6)}` : `$${x.toFixed(4)}`;
export const fmtMs = (x: number | null | undefined) => (x == null ? "–" : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x} ms`);
export const fmtN = (x: number | null | undefined) => (x == null ? "–" : x.toLocaleString());
export const qs = (params: Record<string, string | number | undefined | null>) => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return p.length ? `?${p.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}` : "";
};
