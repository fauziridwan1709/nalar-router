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

export type PlaygroundEndpoint = "support" | "chat";
export const ENDPOINT_PATH: Record<PlaygroundEndpoint, string> = { support: "/v1/support/answer", chat: "/v1/chat/completions" };

export type PlaygroundBody =
  | { message: string; model?: string; prompt_version?: string; include_reasoning?: boolean; tenant?: string }
  | { messages: { role: "system" | "user" | "assistant"; content: string }[]; model?: string; include_reasoning?: boolean; tenant?: string };

const RAW_LIMIT = 256 * 1024;

/**
 * Runs one playground request against the console twin of a public endpoint, streamed or not.
 * Whatever the wire format (support SSE, OpenAI chunks, or one JSON body), the caller gets the
 * same event sequence the support stream uses (meta, route, attempt, token, done…), plus the raw
 * response body so the inspector can show exactly what an API client would receive.
 */
export async function runPlayground(
  endpoint: PlaygroundEndpoint,
  body: PlaygroundBody,
  stream: boolean,
  onEvent: (event: string, data: any) => void,
  onRaw: (raw: string) => void,
  signal?: AbortSignal,
): Promise<{ status: number }> {
  const res = await request(`/api/console/playground/${endpoint}`, { method: "POST", body: JSON.stringify({ ...body, stream }), signal });
  const isSse = res.headers.get("content-type")?.includes("text/event-stream");
  if (!isSse) {
    const text = await res.text();
    let j: any = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* handled below */
    }
    // a run that reached a model (even a failed one) carries its result; anything else is a plain error
    const ran = j && (endpoint === "chat" ? j.x_router : j.requestId);
    if (!ran) {
      if (res.ok) throw new ApiError(res.status, "bad_response", "The gateway sent a response the console couldn't read.");
      throw new ApiError(res.status, j?.error?.code ?? "http_error", j?.error?.message ?? "Something went wrong. Try again.", j?.error?.details);
    }
    onRaw(JSON.stringify(j, null, 2));
    for (const [ev, data] of endpoint === "chat" ? fromChatJson(j) : fromSupportJson(j)) onEvent(ev, data);
    return { status: res.status };
  }
  if (!res.ok) throw await toError(res);

  const requestId = res.headers.get("x-request-id");
  if (endpoint === "chat" && requestId) onEvent("meta", { requestId, t: 0 });
  let raw = "";
  let lastSeq = 1;
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    if (raw.length < RAW_LIMIT) onRaw((raw += chunk.replace(/^: ping\n\n/gm, "")));
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (endpoint === "support") {
        let ev = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (data) onEvent(ev, JSON.parse(data));
        continue;
      }
      // OpenAI chunks; the gateway's route/attempt events ride along as SSE comments
      for (const line of block.split("\n")) {
        const c = line.match(/^: (\w+) (\{.*\})$/);
        if (c) {
          const data = JSON.parse(c[2]);
          if (c[1] === "attempt") lastSeq = data.seq;
          onEvent(c[1], data);
        } else if (line.startsWith("data:")) {
          const d = line.slice(5).trim();
          if (d === "[DONE]") continue;
          const j = JSON.parse(d);
          if (j.error) onEvent("error", j.error);
          const delta = j.choices?.[0]?.delta ?? {};
          if (delta.reasoning) onEvent("reasoning", { seq: lastSeq, backend: j.x_router_backend, text: delta.reasoning });
          if (delta.content) onEvent("token", { text: delta.content });
          if (j.x_router) {
            const { trace: _trace, ...done } = j.x_router;
            onEvent("done", { ...done, t: done.latencyMs });
          }
        }
      }
    }
  }
  return { status: res.status };
}

type Ev = [string, any];
const byTime = (evs: Ev[]) => evs.sort((a, b) => (a[1]?.t ?? 0) - (b[1]?.t ?? 0));
const reasoningEvents = (reasoning: Record<string, string> | undefined, attempts: any[]): Ev[] =>
  Object.entries(reasoning ?? {}).map(([backend, text]) => ["reasoning", { backend, text, seq: attempts.find((a) => a.backend === backend)?.seq ?? 1 }]);

function fromSupportJson(j: any): Ev[] {
  const { attempts = [], answer, refused, refusal, intentDetail, retrieved, route, error, steps = [], reasoning, ...done } = j;
  const timed: Ev[] = byTime([
    ...(route ? [["route", route] as Ev] : []),
    ...(retrieved ? [["retrieval", retrieved] as Ev] : []),
    ...steps.map((x: any): Ev => ["step", x]),
    ...attempts.map((x: any): Ev => ["attempt", x]),
    ...(intentDetail ? [["intent", intentDetail] as Ev] : []),
    ...(refusal ? [["refusal", refusal] as Ev] : []),
    ...(error ? [["error", error] as Ev] : []),
  ]);
  return [
    ["meta", { requestId: j.requestId, t: 0 }],
    ...reasoningEvents(reasoning, attempts),
    ...timed,
    ...(!refused && answer ? [["token", { text: answer }] as Ev] : []),
    ["done", { ...done, attempts: attempts.length, t: done.latencyMs }],
  ];
}

function fromChatJson(j: any): Ev[] {
  const { route, attempts = [], reasoning, ...done } = j.x_router;
  const content = j.choices?.[0]?.message?.content;
  return [
    ["meta", { requestId: j.id, t: 0 }],
    ...reasoningEvents(reasoning, attempts),
    ...byTime([...(route ? [["route", route] as Ev] : []), ...attempts.map((x: any): Ev => ["attempt", x])]),
    ...(j.error ? [["error", j.error] as Ev] : []),
    ...(content ? [["token", { text: content }] as Ev] : []),
    ["done", { ...done, attempts: attempts.length, t: done.latencyMs }],
  ];
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
