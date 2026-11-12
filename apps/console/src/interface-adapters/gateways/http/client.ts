/**
 * HTTP client for the gateway's console API. Authentication is a session cookie (HttpOnly, so
 * this code never sees it) plus a per-session CSRF token sent on every state-changing request.
 * The console holds no tenant API key and no admin token.
 */
import { ApiError } from "../../../entities/errors";

let csrfToken = "";
export const setCsrf = (t: string) => (csrfToken = t);
/** called when any request finds the session gone, so the shell can show the sign-in page */
let onSignedOut: () => void = () => {};
export const setSignedOutHandler = (f: () => void) => (onSignedOut = f);

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function request(path: string, init: RequestInit = {}) {
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

/** the gateway's `{error: {code, message, details}}` as an ApiError; a generic line for anything odd */
export async function toError(res: Response) {
  const j = await res.json().catch(() => ({}));
  return new ApiError(res.status, j?.error?.code ?? "http_error", j?.error?.message ?? "Something went wrong. Try again.", j?.error?.details);
}

/** JSON in, JSON out; non-2xx becomes an ApiError */
export async function call<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await request(path, json !== undefined ? { ...rest, body: JSON.stringify(json) } : rest);
  if (!res.ok) throw await toError(res);
  return (res.status === 204 ? null : await res.json()) as T;
}

/** query string from the defined, non-empty params */
export const qs = (params: Record<string, string | number | undefined | null>) => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return p.length ? `?${p.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}` : "";
};
