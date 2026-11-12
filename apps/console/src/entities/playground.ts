/**
 * One playground run as data, and how gateway events change it. The reducer is pure, so the
 * same events always produce the same turn, whether they arrived streamed or from a JSON body.
 */
import type {
  AttemptEvent, DoneEvent, EventPayloads, FilledSlot, GatewayEvent, IntentEvent, MetaEvent, RefusalEvent,
  RetrievalEvent, RouteEvent, StepEvent,
} from "./events";
import { fmtMs, fmtN, fmtUsd, humanize } from "./format";
import type { PlaygroundEndpoint } from "./models";

/** the first answer token, which the trace shows as its own line (tokens aren't traced one by one) */
export interface FirstTokenEntry {
  ttftMs: number;
  backend: string | null;
}

type TracedPayloads = Omit<EventPayloads, "token" | "reasoning"> & { first_token: FirstTokenEntry };

/** one line of the trace timeline: an event and the server-side time it happened */
export type TraceEntry = { [Name in keyof TracedPayloads]: { event: Name; t: number; data: TracedPayloads[Name] } }[keyof TracedPayloads];

export interface TurnError {
  code: string;
  message: string;
  details?: unknown;
}

export interface Turn {
  id: number;
  endpoint: PlaygroundEndpoint;
  /** streamed (SSE) or one JSON body */
  stream: boolean;
  /** the response body as an API client would receive it (SSE text or pretty JSON) */
  raw: string;
  system?: string;
  question: string;
  tenant: string;
  answer: string;
  refusal?: RefusalEvent;
  error?: TurnError;
  route?: RouteEvent;
  retrieval?: RetrievalEvent;
  intent?: IntentEvent;
  /** the latest status of each attempt, in order */
  attempts: AttemptEvent[];
  /** reasoning per attempt (a fallback can produce reasoning from several models) */
  reasoning: { seq: number; backend: string; text: string }[];
  /** every event except tokens and reasoning, in time order */
  trace: TraceEntry[];
  done?: DoneEvent;
  meta?: MetaEvent;
  streaming: boolean;
  settings: { model: string; prompt_version: string; include_reasoning: boolean };
}

/** applies one gateway event to a turn */
export function applyEvent(turn: Turn, e: GatewayEvent): Turn {
  switch (e.event) {
    case "token":
      return { ...turn, answer: turn.answer + e.data.text };
    case "reasoning":
      return { ...turn, reasoning: appendReasoning(turn.reasoning, e.data) };
    default:
      break;
  }
  const traced = { ...turn, trace: [...turn.trace, { event: e.event, t: e.data.t ?? 0, data: e.data } as TraceEntry] };
  switch (e.event) {
    case "meta":
      return { ...traced, meta: e.data };
    case "route":
      return { ...traced, route: e.data };
    case "retrieval":
      return { ...traced, retrieval: e.data };
    case "attempt":
      return { ...traced, attempts: upsertAttempt(traced.attempts, e.data) };
    case "intent":
      return { ...traced, intent: e.data };
    case "refusal":
      return { ...traced, refusal: e.data };
    case "error":
      return { ...traced, error: e.data };
    case "done":
      return { ...traced, trace: withFirstToken(traced.trace, e.data), done: e.data, streaming: false };
    default:
      return traced;
  }
}

/** "started" and then the final status share a seq: keep the latest, in seq order */
function upsertAttempt(attempts: AttemptEvent[], attempt: AttemptEvent) {
  return [...attempts.filter((a) => a.seq !== attempt.seq), attempt].sort((a, b) => a.seq - b.seq);
}

/** reasoning arrives in chunks; chunks of the same attempt join into one block */
function appendReasoning(blocks: Turn["reasoning"], chunk: EventPayloads["reasoning"]) {
  const last = blocks[blocks.length - 1];
  if (last && last.seq === chunk.seq) return [...blocks.slice(0, -1), { ...last, text: last.text + chunk.text }];
  return [...blocks, { seq: chunk.seq, backend: chunk.backend, text: chunk.text }];
}

/** adds the first-token line at the gateway's measured time to first token, in time order */
function withFirstToken(trace: TraceEntry[], done: DoneEvent): TraceEntry[] {
  if (done.ttftMs == null) return trace;
  const firstToken: TraceEntry = { event: "first_token", t: done.ttftMs, data: { ttftMs: done.ttftMs, backend: done.backend } };
  return [...trace, firstToken].sort((a, b) => a.t - b.t);
}

/** one pipeline step, in words */
export function describeStep(step: StepEvent): string {
  switch (step.name) {
    case "pii_guard": {
      const masked = step.masked.length ? ` · ${step.masked.map((m) => m.label.toLowerCase()).join(", ")}` : "";
      return `PII guardrail (${step.mode}): ${step.detail}${masked}`;
    }
    case "scope_gate":
      return `${step.passed ? "scope check passed" : "scope check: refuse"}: ${step.detail}`;
    case "route_classified":
      return `classified for routing: ${step.detail}`;
    case "cascade_escalated":
      return `cascade: ${step.backend} was unsure (${step.detail})`;
    case "placeholders_rendered": {
      const sources = [...new Set(step.slots.map((slot) => slot.source))].join(", ");
      return `filled ${step.slots.length} placeholder${step.slots.length === 1 ? "" : "s"} (${sources})`;
    }
    case "header_validated":
      return `header validated: ${step.detail}`;
  }
}

/** one line of the trace timeline, in words */
export function describeTraceEntry(entry: TraceEntry): string {
  switch (entry.event) {
    case "meta": {
      const budget = entry.data.admission ? `, up to ${fmtN(entry.data.admission.maxCompletionTokens)} completion tokens` : "";
      return `authenticated; quota admitted${budget}`;
    }
    case "route":
      return `routed by ${entry.data.rule}: ${entry.data.chain.join(" › ")}`;
    case "retrieval":
      return `retrieved ${entry.data.entries.length} KB entries, top intent ${entry.data.topIntent ?? "none"}, coverage ${entry.data.coverage}`;
    case "step":
      return describeStep(entry.data);
    case "attempt": {
      const a = entry.data;
      if (a.status === "started") return `attempt ${a.seq} sent to ${a.backend}`;
      return `attempt ${a.seq} ${a.backend}: ${humanize(a.status)}${a.error ? ` (${a.error})` : ""}`;
    }
    case "intent":
      return `intent ${entry.data.intent}, confidence ${entry.data.confidence} (${entry.data.label}); first answer token sent, no fallback after this`;
    case "refusal":
      return `refused: ${entry.data.reason}${entry.data.detail ? ` (${entry.data.detail})` : ""}`;
    case "error":
      return `error: ${entry.data.code}`;
    case "model":
      return `streaming from ${entry.data.backend} (${entry.data.model})`;
    case "first_token": {
      const from = entry.data.backend ? ` from ${entry.data.backend}` : "";
      return `first token${from}: time to first token ${fmtMs(entry.data.ttftMs)}`;
    }
    case "done": {
      const d = entry.data;
      const firstToken = d.ttftMs != null ? ` (first token at ${fmtMs(d.ttftMs)})` : "";
      return `response complete in ${fmtMs(d.latencyMs)}${firstToken}; metered: ${humanize(d.outcome)}, ${fmtN(d.usage?.totalTokens)} tokens, ${fmtUsd(d.costUsd)}`;
    }
  }
}

export type Tone = "ok" | "good" | "warn" | "bad" | "pii" | "";

/** how a trace line is coloured: failures, milestones, refusals, masked personal data */
export function traceTone(entry: TraceEntry): Tone {
  switch (entry.event) {
    case "error":
      return "bad";
    case "attempt":
      return ATTEMPT_TRACE_TONE[entry.data.status] ?? "bad";
    case "intent":
    case "first_token":
      return "ok";
    case "done":
      return entry.data.outcome === "success" ? "ok" : "";
    case "refusal":
      return "warn";
    case "step":
      if (entry.data.name === "scope_gate" && !entry.data.passed) return "warn";
      if (entry.data.name === "pii_guard" && entry.data.masked.length > 0) return "pii";
      return "";
    default:
      return "";
  }
}

/** on the trace, a classifier call or a refusal isn't a failure; a cascade escalation is worth noticing */
const ATTEMPT_TRACE_TONE: Record<string, Tone> = { started: "", ok: "", classified: "", refused: "", escalated: "warn" };

const ATTEMPT_TONE: Record<string, Tone> = { ok: "good", started: "", classified: "", refused: "warn", escalated: "warn" };
/** an attempt's status tag: anything not listed is a failure */
export const attemptTone = (status: string): Tone => ATTEMPT_TONE[status] ?? "bad";

const SLOT_TONE: Record<FilledSlot["source"], Tone> = { fallback: "warn", message: "good", pii: "pii", profile: "", ui_label: "" };
/** a filled placeholder's source tag */
export const slotTone = (source: FilledSlot["source"]): Tone => SLOT_TONE[source] ?? "";
