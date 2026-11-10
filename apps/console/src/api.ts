export interface DemoTenant {
  id: string;
  name: string;
  plan: string;
  apiKey: string;
  allowedTiers: string[];
}
export interface DemoConfig {
  adminToken: string;
  tenants: DemoTenant[];
  backends: { id: string; tier: string; model: string; location: string; enabled: boolean }[];
  intents: string[];
}

export async function loadDemoConfig(): Promise<DemoConfig | null> {
  const r = await fetch("/api/demo-config");
  return r.ok ? r.json() : null;
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

/** POST + parse a Server-Sent-Events body (EventSource can't POST). */
export async function streamSupport(
  apiKey: string,
  body: { message: string; model?: string; prompt_version?: string; include_reasoning?: boolean },
  onEvent: (event: string, data: any) => void,
  signal?: AbortSignal,
) {
  const res = await fetch("/v1/support/answer", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new ApiError(res.status, j?.error?.code ?? "http_error", j?.error?.message ?? res.statusText, j?.error?.details);
  }
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

export async function admin<T = any>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", "x-admin-token": token, ...(init.headers ?? {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j?.error?.code ?? "http_error", j?.error?.message ?? r.statusText);
  return j as T;
}

export interface BackendStatus {
  id: string;
  tier: string;
  model: string;
  enabled: boolean;
  location: string;
  health?: { label: "online" | "offline"; availability: string; reason: string; checkedAt: number | null; probeLatencyMs: number | null };
  breaker: { state: string; reopensInMs: number; lastError: string | null; consecutiveFailures: number };
  chaos: { failRate: number; mode: string; addedLatencyMs: number };
  [k: string]: any;
}

export const fmtUsd = (x: number | null | undefined) =>
  x == null ? "–" : x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(6)}` : `$${x.toFixed(4)}`;
export const fmtMs = (x: number | null | undefined) => (x == null ? "–" : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x} ms`);
export const fmtN = (x: number | null | undefined) => (x == null ? "–" : x.toLocaleString());
