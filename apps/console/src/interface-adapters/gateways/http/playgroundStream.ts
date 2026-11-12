/**
 * The playground's wire adapter. It runs one request against the console twin of a public
 * endpoint, streamed or not, and turns whatever comes back (support SSE, OpenAI chunks, or one
 * JSON body) into the same typed event sequence: meta, route, attempt, token, done… It also
 * passes on the raw response body, so the inspector can show exactly what an API client receives.
 */
import { ApiError } from "../../../entities/errors";
import { gatewayEvent, type GatewayEvent } from "../../../entities/events";
import type { PlaygroundBody, PlaygroundEndpoint } from "../../../entities/models";
import { request, toError } from "./client";

/** the raw-body view stops growing past this, so a long stream can't bloat the page */
const RAW_LIMIT = 256 * 1024;

type Emit = (e: GatewayEvent) => void;

export async function runPlaygroundRequest(
  endpoint: PlaygroundEndpoint,
  body: PlaygroundBody,
  stream: boolean,
  onEvent: Emit,
  onRaw: (raw: string) => void,
  signal?: AbortSignal,
): Promise<{ status: number }> {
  const res = await request(`/api/console/playground/${endpoint}`, { method: "POST", body: JSON.stringify({ ...body, stream }), signal });
  const isSse = res.headers.get("content-type")?.includes("text/event-stream");
  if (!isSse) {
    await readJsonResponse(res, endpoint, onEvent, onRaw);
    return { status: res.status };
  }
  if (!res.ok) throw await toError(res);

  const requestId = res.headers.get("x-request-id");
  if (endpoint === "chat" && requestId) onEvent(gatewayEvent("meta", { requestId, t: 0 }));
  const parseBlock = endpoint === "support" ? (block: string) => parseSupportBlock(block, onEvent) : chatChunkParser(onEvent);
  await readSseBlocks(res, parseBlock, onRaw);
  return { status: res.status };
}

/** reads an SSE body block by block (blocks end with a blank line), reporting the raw text as it grows */
async function readSseBlocks(res: Response, onBlock: (block: string) => void, onRaw: (raw: string) => void) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const chunk = decoder.decode(value, { stream: true });
    if (raw.length < RAW_LIMIT) {
      raw += chunk.replace(/^: ping\n\n/gm, "");
      onRaw(raw);
    }
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n\n")) >= 0) {
      onBlock(pending.slice(0, end));
      pending = pending.slice(end + 2);
    }
  }
}

/** support SSE: `event: <name>` and `data: <json>` lines */
function parseSupportBlock(block: string, emit: Emit) {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (data) emit(gatewayEvent(event, JSON.parse(data)));
}

/**
 * OpenAI chat chunks. The gateway's route and attempt events ride along as SSE comments
 * (`: attempt {…}`), which OpenAI clients ignore; the final chunk carries the summary in `x_router`.
 */
function chatChunkParser(emit: Emit) {
  // reasoning chunks don't say which attempt they belong to; the latest attempt does
  let currentAttempt = 1;
  return (block: string) => {
    for (const line of block.split("\n")) {
      const comment = line.match(/^: (\w+) (\{.*\})$/);
      if (comment) {
        const data = JSON.parse(comment[2]);
        if (comment[1] === "attempt") currentAttempt = data.seq;
        emit(gatewayEvent(comment[1], data));
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      const chunk = JSON.parse(payload);
      if (chunk.error) emit(gatewayEvent("error", chunk.error));
      const delta = chunk.choices?.[0]?.delta ?? {};
      if (delta.reasoning) emit(gatewayEvent("reasoning", { seq: currentAttempt, backend: chunk.x_router_backend, text: delta.reasoning }));
      if (delta.content) emit(gatewayEvent("token", { text: delta.content }));
      if (chunk.x_router) {
        const { trace: _trace, ...done } = chunk.x_router;
        emit(gatewayEvent("done", { ...done, t: done.latencyMs }));
      }
    }
  };
}

/** a JSON body: a finished run (replayed as events) or a plain error */
async function readJsonResponse(res: Response, endpoint: PlaygroundEndpoint, emit: Emit, onRaw: (raw: string) => void) {
  const text = await res.text();
  let json: WireBody | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: reported below as an unreadable response
  }
  // a run that reached a model (even a failed one) carries its result; anything else is a plain error
  const ran = json && (endpoint === "chat" ? json.x_router : json.requestId);
  if (!json || !ran) {
    if (res.ok) throw new ApiError(res.status, "bad_response", "The gateway sent a response the console couldn't read.");
    throw new ApiError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? "Something went wrong. Try again.", json?.error?.details);
  }
  onRaw(JSON.stringify(json, null, 2));
  const events = endpoint === "chat" ? chatJsonEvents(json as ChatJsonBody) : supportJsonEvents(json as SupportJsonBody);
  for (const e of events) emit(e);
}

interface WireAttempt {
  seq: number;
  backend: string;
}

/** any JSON reply: a run's result, or `{error}` */
interface WireBody {
  requestId?: string;
  x_router?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
}

/** POST /v1/support/answer with stream: false; the remaining fields are the done summary */
interface SupportJsonBody {
  requestId: string;
  latencyMs: number;
  attempts?: WireAttempt[];
  answer?: string;
  refused?: boolean;
  refusal?: unknown;
  intentDetail?: unknown;
  retrieved?: unknown;
  route?: unknown;
  error?: unknown;
  steps?: unknown[];
  reasoning?: Record<string, string>;
  [summaryField: string]: unknown;
}

/** POST /v1/chat/completions with stream: false: OpenAI's chat.completion plus `x_router` */
interface ChatJsonBody {
  id: string;
  choices?: { message?: { content?: string } }[];
  error?: unknown;
  x_router: { route?: unknown; attempts?: WireAttempt[]; reasoning?: Record<string, string>; latencyMs: number; [summaryField: string]: unknown };
}

const timeOf = (e: GatewayEvent) => ("t" in e.data ? (e.data.t ?? 0) : 0);
const byTime = (events: GatewayEvent[]) => events.sort((a, b) => timeOf(a) - timeOf(b));

/** a JSON body has reasoning per backend; the stream has it per attempt */
const reasoningEvents = (reasoning: Record<string, string> | undefined, attempts: WireAttempt[]) =>
  Object.entries(reasoning ?? {}).map(([backend, text]) =>
    gatewayEvent("reasoning", { backend, text, seq: attempts.find((a) => a.backend === backend)?.seq ?? 1 }),
  );

/** the support JSON body, replayed as the events its stream would have sent */
function supportJsonEvents(json: SupportJsonBody): GatewayEvent[] {
  const { attempts = [], answer, refused, refusal, intentDetail, retrieved, route, error, steps = [], reasoning, ...done } = json;
  const timed = byTime([
    ...(route ? [gatewayEvent("route", route)] : []),
    ...(retrieved ? [gatewayEvent("retrieval", retrieved)] : []),
    ...steps.map((step) => gatewayEvent("step", step)),
    ...attempts.map((attempt) => gatewayEvent("attempt", attempt)),
    ...(intentDetail ? [gatewayEvent("intent", intentDetail)] : []),
    ...(refusal ? [gatewayEvent("refusal", refusal)] : []),
    ...(error ? [gatewayEvent("error", error)] : []),
  ]);
  return [
    gatewayEvent("meta", { requestId: json.requestId, t: 0 }),
    ...reasoningEvents(reasoning, attempts),
    ...timed,
    ...(!refused && answer ? [gatewayEvent("token", { text: answer })] : []),
    gatewayEvent("done", { ...done, attempts: attempts.length, t: done.latencyMs }),
  ];
}

/** the chat JSON body (OpenAI's chat.completion plus `x_router`), replayed as events */
function chatJsonEvents(json: ChatJsonBody): GatewayEvent[] {
  const { route, attempts = [], reasoning, ...done } = json.x_router;
  const content = json.choices?.[0]?.message?.content;
  return [
    gatewayEvent("meta", { requestId: json.id, t: 0 }),
    ...reasoningEvents(reasoning, attempts),
    ...byTime([...(route ? [gatewayEvent("route", route)] : []), ...attempts.map((attempt) => gatewayEvent("attempt", attempt))]),
    ...(json.error ? [gatewayEvent("error", json.error)] : []),
    ...(content ? [gatewayEvent("token", { text: content })] : []),
    gatewayEvent("done", { ...done, attempts: attempts.length, t: done.latencyMs }),
  ];
}
