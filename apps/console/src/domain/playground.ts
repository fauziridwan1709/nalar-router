/**
 * One playground run as data, and how gateway events change it. The reducer is pure, so the
 * same events always produce the same turn, whether they arrived streamed or from a JSON body.
 */
import type { PlaygroundEndpoint } from "./models";
import { fmtN, fmtUsd } from "./format";

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
  refusal?: any;
  error?: { code: string; message: string; details?: any };
  route?: any;
  retrieval?: any;
  intent?: any;
  attempts: any[];
  /** reasoning per attempt (a fallback can produce reasoning from several models) */
  reasoning: { seq: number; backend: string; text: string }[];
  /** every non-token event with its server-side elapsed time, for the trace */
  trace: { event: string; t: number; data: any }[];
  done?: any;
  meta?: any;
  streaming: boolean;
  settings: { model: string; prompt_version: string; include_reasoning: boolean };
}

/** applies one event in the support stream's vocabulary to a turn */
export function applyEvent(t0: Turn, ev: string, data: any): Turn {
  // tokens and reasoning are too many to trace; everything else goes on the timeline
  const t = ev === "token" || ev === "reasoning" ? t0 : { ...t0, trace: [...t0.trace, { event: ev, t: data.t ?? 0, data }] };
  switch (ev) {
    case "meta": return { ...t, meta: data };
    case "route": return { ...t, route: data };
    case "retrieval": return { ...t, retrieval: data };
    case "attempt": {
      // "started" then the final status share a seq; keep the latest, in order
      const rest = t.attempts.filter((a) => a.seq !== data.seq);
      return { ...t, attempts: [...rest, data].sort((a, b) => a.seq - b.seq) };
    }
    case "intent": return { ...t, intent: data };
    case "token": return { ...t, answer: t.answer + data.text };
    case "reasoning": {
      const last = t.reasoning[t.reasoning.length - 1];
      if (last && last.seq === data.seq) return { ...t, reasoning: [...t.reasoning.slice(0, -1), { ...last, text: last.text + data.text }] };
      return { ...t, reasoning: [...t.reasoning, { seq: data.seq, backend: data.backend, text: data.text }] };
    }
    case "refusal": return { ...t, refusal: data };
    case "error": return { ...t, error: data };
    case "done": return { ...t, done: data, streaming: false };
    default: return t;
  }
}

/** one line of the trace timeline per event */
export const TRACE_LABEL: Record<string, (d: any) => string> = {
  meta: (d) => `authenticated; quota admitted${d.admission ? `, up to ${fmtN(d.admission.maxCompletionTokens)} completion tokens` : ""}`,
  route: (d) => `routed by ${d.rule}: ${d.chain.join(" › ")}`,
  retrieval: (d) => `retrieved ${d.entries.length} KB entries, top intent ${d.topIntent ?? "none"}, coverage ${d.coverage}`,
  step: (d) =>
    d.name === "pii_guard"
      ? `PII guardrail (${d.mode}): ${d.detail}${d.masked?.length ? ` · ${d.masked.map((m: any) => m.label.toLowerCase()).join(", ")}` : ""}`
      : d.name === "scope_gate"
      ? `${d.passed ? "scope check passed" : "scope check: refuse"}: ${d.detail}`
      : d.name === "placeholders_rendered"
        ? `filled ${d.slots.length} placeholder${d.slots.length === 1 ? "" : "s"} (${[...new Set(d.slots.map((x: any) => x.source))].join(", ")})`
        : `header validated: ${d.detail}`,
  attempt: (d) => (d.status === "started" ? `attempt ${d.seq} sent to ${d.backend}` : `attempt ${d.seq} ${d.backend}: ${d.status.replace(/_/g, " ")}${d.error ? ` (${d.error})` : ""}`),
  intent: (d) => `intent ${d.intent}, confidence ${d.confidence} (${d.label}); first answer token sent, no fallback after this`,
  refusal: (d) => `refused: ${d.reason}${d.detail ? ` (${d.detail})` : ""}`,
  error: (d) => `error: ${d.code}`,
  done: (d) => `metered: ${d.outcome.replace(/_/g, " ")}, ${fmtN(d.usage?.totalTokens)} tokens, ${fmtUsd(d.costUsd)}`,
};
