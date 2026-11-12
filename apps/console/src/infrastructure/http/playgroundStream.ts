/**
 * The playground's wire adapter: runs one request against the console twin of a public endpoint
 * and turns whatever comes back (support SSE, OpenAI chunks, or one JSON body) into the same
 * event sequence the support stream uses: meta, route, attempt, token, done…
 */
import { ApiError } from "../../domain/errors";
import type { PlaygroundBody, PlaygroundEndpoint } from "../../domain/models";
import { request, toError } from "./client";

const RAW_LIMIT = 256 * 1024;

/**
 * Runs one playground request against the console twin of a public endpoint, streamed or not.
 * Whatever the wire format (support SSE, OpenAI chunks, or one JSON body), the caller gets the
 * same event sequence the support stream uses (meta, route, attempt, token, done…), plus the raw
 * response body so the inspector can show exactly what an API client would receive.
 */
export async function runPlaygroundRequest(
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



