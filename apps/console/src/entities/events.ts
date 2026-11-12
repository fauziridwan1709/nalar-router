/**
 * The events a playground run produces, typed. The gateway emits them on the support SSE stream
 * (and the playground adapter rebuilds the same sequence from OpenAI chunks or a JSON body), so
 * the console reads one vocabulary whatever the endpoint or wire format.
 *
 * Only the fields the console reads are listed. `t` is the server-side elapsed time in ms since
 * the request started; tokens and reasoning chunks don't carry it.
 */

interface Timed {
  t?: number;
}

export interface MetaEvent extends Timed {
  requestId: string;
  admission?: { maxCompletionTokens: number; tokensRemaining: number; requestsRemaining: number };
}

/** auto-smart's verdict, or why it failed and the heuristic decided */
export interface ClassifierVerdict {
  status: "ok" | "failed";
  backend?: string;
  latencyMs?: number;
  label?: "simple" | "complex";
  confidence?: number;
  why?: string;
  error?: string;
}

/** the complexity score behind auto routing, and the signals that added to it */
export interface ComplexityAssessment {
  score: number;
  level: string;
  threshold: number;
  signals: { id: string; weight: number; detail: string }[];
}

export interface RouteEvent extends Timed {
  rule: string;
  reason: string;
  mode?: "heuristic" | "smart" | "cascade" | "pinned";
  chain: string[];
  /** what the router looked at; open-ended, so only the parts the console shows are typed */
  signals?: { classifier?: ClassifierVerdict; complexity?: ComplexityAssessment; [signal: string]: unknown };
}

export interface KbHit {
  id: string;
  intent: string;
  score: number;
  question: string;
  answer: string;
}

export interface RetrievalEvent extends Timed {
  coverage: number;
  topIntent: string | null;
  votes: { intent: string; share: number }[];
  entries: KbHit[];
}

export interface MaskedValue {
  type: string;
  label: string;
  placeholder: string;
}

/** a placeholder the gateway filled, and where the value came from */
export interface FilledSlot {
  name: string;
  value: string;
  source: "message" | "profile" | "ui_label" | "fallback" | "pii";
}

/** one step of the support pipeline, told apart by `name` */
export type StepEvent = Timed &
  (
    | { name: "pii_guard"; mode: string; masked: MaskedValue[]; detail: string }
    | { name: "scope_gate"; passed: boolean; detail: string }
    | { name: "route_classified"; detail: string }
    | { name: "header_validated"; backend: string; detail: string }
    | { name: "cascade_escalated"; backend: string; detail: string }
    | { name: "placeholders_rendered"; detail: string; slots: FilledSlot[] }
  );

/** one call to one backend: `status` is "started", then its outcome ("ok", "timeout", …) */
export interface AttemptEvent extends Timed {
  seq: number;
  backend: string;
  status: string;
  /** public text only: provider errors stay in the gateway's database */
  error?: string | null;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
}

export interface IntentEvent extends Timed {
  intent: string;
  confidence: number;
  label: string;
  components: { retrievalVote: number; coverage: number; model: number };
  agreesWithRetrieval: boolean;
}

export interface RefusalEvent extends Timed {
  reason: string;
  message: string;
  detail?: string;
  intent?: string | null;
  confidence?: number | null;
}

export interface ErrorEvent extends Timed {
  code: string;
  message: string;
  details?: unknown;
}

/** the metered summary that ends every run */
export interface DoneEvent extends Timed {
  requestId?: string;
  outcome: string;
  backend: string | null;
  model: string | null;
  fallbackUsed: boolean;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; source: string } | null;
  costUsd: number | null;
  latencyMs: number;
  ttftMs: number | null;
  quota: { tokensRemaining: number; requestsRemaining: number } | null;
}

export interface TokenEvent {
  text: string;
}

export interface ReasoningEvent {
  seq: number;
  backend: string;
  text: string;
}

/** which backend started streaming the answer (chat) */
export interface ModelEvent extends Timed {
  backend: string;
  model: string;
}

export interface EventPayloads {
  meta: MetaEvent;
  route: RouteEvent;
  retrieval: RetrievalEvent;
  step: StepEvent;
  attempt: AttemptEvent;
  intent: IntentEvent;
  refusal: RefusalEvent;
  error: ErrorEvent;
  done: DoneEvent;
  token: TokenEvent;
  reasoning: ReasoningEvent;
  model: ModelEvent;
}

export type EventName = keyof EventPayloads;

/** one event, with its payload typed by name: `switch (e.event)` narrows `e.data` */
export type GatewayEvent = { [Name in EventName]: { event: Name; data: EventPayloads[Name] } }[EventName];

/** builds an event from wire data; the shapes are the gateway's, trusted at this boundary */
export const gatewayEvent = (event: string, data: unknown) => ({ event, data }) as GatewayEvent;
