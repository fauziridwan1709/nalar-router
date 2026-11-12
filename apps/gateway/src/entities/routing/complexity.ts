/**
 * Query complexity: how likely the cheap model is to struggle with this request.
 *
 * A deterministic, explainable heuristic, not a model: it costs nothing, adds no latency and
 * gives the same answer every time, so a routing decision can be replayed and audited. Each
 * signal that fires adds its weight; the score is the sum, capped at 1. The router escalates to
 * the strong tier when the score reaches `complexityThreshold` (main/config.ts, default 0.5).
 *
 * The weights are chosen so that each of the two original rules still escalates on its own
 * (a long query, ambiguous retrieval: 0.5 each), while the softer signals only escalate in
 * combination. For example, a "why" question stays on the fast tier, but "compare…, explain…
 * and recommend…" does not.
 *
 * | signal            | fires when                                                        | weight          |
 * |-------------------|-------------------------------------------------------------------|-----------------|
 * | long_query        | newest user turn > longQueryTokens (60)                           | 0.5             |
 * | medium_query      | > half of that                                                    | 0.15            |
 * | ambiguous_intent  | support only: top intent's retrieval vote share < 0.6             | 0.5             |
 * | multi_question    | 2+ question marks, or 2+ distinct wh-questions                    | 0.25            |
 * | reasoning         | analysis cues: compare, explain, trade-offs, step by step…        | 0.2 / 0.35 / 0.5 for 1 / 2 / 3+ cues |
 * | multi_step        | a numbered or bulleted list of 2+ items, or "first … then …"      | 0.2             |
 * | constraints       | 2+ output constraints: "at least", "no more than", "as JSON"…     | 0.15            |
 * | code              | a code block or code-like syntax                                  | 0.4             |
 * | math              | an arithmetic expression or "calculate / how much in total"       | 0.15            |
 * | long_conversation | chat only: 6+ messages of history                                 | 0.1             |
 */
export type ComplexitySignalId =
  | "long_query"
  | "medium_query"
  | "ambiguous_intent"
  | "multi_question"
  | "reasoning"
  | "multi_step"
  | "constraints"
  | "code"
  | "math"
  | "long_conversation";

export interface ComplexitySignal {
  id: ComplexitySignalId;
  weight: number;
  /** human-readable evidence, e.g. `reasoning cues: compare, trade-offs` */
  detail: string;
}

export type ComplexityLevel = "simple" | "moderate" | "complex";

export interface ComplexityAssessment {
  /** 0–1, the sum of the weights of the signals that fired */
  score: number;
  level: ComplexityLevel;
  /** the score at or above which the router escalates */
  threshold: number;
  signals: ComplexitySignal[];
}

export interface ComplexityInput {
  /** the newest user turn (masked, if the PII guardrail masked it) */
  text: string;
  /** estimated tokens of that turn */
  queryTokens: number;
  /** chat only: messages in the conversation */
  turns?: number;
  /** support only: share of retrieved entries voting for the top intent (0–1) */
  retrievalTopShare?: number;
}

export interface ComplexityOptions {
  longQueryTokens: number;
  ambiguousVoteShare: number;
  complexityThreshold: number;
}

export const COMPLEXITY_WEIGHTS = {
  long_query: 0.5,
  medium_query: 0.15,
  ambiguous_intent: 0.5,
  multi_question: 0.25,
  reasoning: [0.2, 0.35, 0.5] as const,
  multi_step: 0.2,
  constraints: 0.15,
  code: 0.4,
  math: 0.15,
  long_conversation: 0.1,
} as const;

// "plan" and "design" are left out on purpose: in support traffic they mean a subscription plan
// or a product design, not a planning task.
const REASONING_CUES =
  /\b(why|explain|compare|comparison|difference between|versus|vs\.?|pros and cons|trade-?offs?|analy[sz]e|analysis|evaluate|assess|recommend(?:ation)?|which (?:one )?is better|step[- ]by[- ]step|justify|implications?|root cause|reason(?:ing)? through|strateg(?:y|ies))\b/gi;
const WH_WORDS = /\b(what|how|why|when|where|which|who)\b/gi;
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+\S/gm;
/** "1. change my address 2. update my phone": numbering inline, counted only if it starts at 1 and goes on to 2 */
const INLINE_NUMBER = /(?:^|\s)(\d{1,2})[.)]\s+(?=[A-Za-z])/g;
const SEQUENCE = /\bfirst\b[\s\S]{1,200}\b(?:then|next|after that|finally)\b/i;
const CONSTRAINTS =
  /\b(at least|at most|no more than|fewer than|exactly|must|without using|only use|in (?:json|yaml|a table|markdown|bullet points)|as (?:json|yaml|a table|a list)|word limit|under \d+ words)\b/gi;
const CODE = /```|\b(?:function\s*\(|def \w+\(|class \w+[:({]|SELECT\b[\s\S]+\bFROM\b|import \w+|console\.log|=>\s*[{(]|\w+\(\)\s*;)/;
// "-" and "/" count only with spaces around them, so ids and dates (123-456, 12/05) aren't arithmetic
const MATH = /\d\s*[*×^+]\s*\d|\d\s+[-/]\s+\d|\b(calculate|compute|how much (?:in total|altogether)|percentage of|sum of)\b/i;

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))];
const round = (n: number) => Math.round(n * 100) / 100;

export function assessComplexity(input: ComplexityInput, opts: ComplexityOptions): ComplexityAssessment {
  const W = COMPLEXITY_WEIGHTS;
  const text = input.text ?? "";
  const signals: ComplexitySignal[] = [];
  const add = (id: ComplexitySignalId, weight: number, detail: string) => signals.push({ id, weight, detail });

  if (input.queryTokens > opts.longQueryTokens) add("long_query", W.long_query, `${input.queryTokens} tokens > ${opts.longQueryTokens}`);
  else if (input.queryTokens > opts.longQueryTokens / 2) add("medium_query", W.medium_query, `${input.queryTokens} tokens > ${opts.longQueryTokens / 2}`);

  if (input.retrievalTopShare !== undefined && input.retrievalTopShare < opts.ambiguousVoteShare) {
    add("ambiguous_intent", W.ambiguous_intent, `top intent share ${input.retrievalTopShare.toFixed(2)} < ${opts.ambiguousVoteShare}`);
  }

  const questionMarks = (text.match(/\?/g) ?? []).length;
  const wh = uniq(text.match(WH_WORDS) ?? []);
  if (questionMarks >= 2 || wh.length >= 2) {
    add("multi_question", W.multi_question, questionMarks >= 2 ? `${questionMarks} questions` : `asks ${wh.join(" + ")}`);
  }

  const cues = uniq(text.match(REASONING_CUES) ?? []);
  if (cues.length) add("reasoning", W.reasoning[Math.min(cues.length, 3) - 1], `cues: ${cues.join(", ")}`);

  const lineItems = (text.match(LIST_ITEM) ?? []).length;
  const numbers = new Set([...text.matchAll(INLINE_NUMBER)].map((m) => Number(m[1])));
  const inlineItems = numbers.has(1) && numbers.has(2) ? numbers.size : 0;
  const items = Math.max(lineItems, inlineItems);
  if (items >= 2) add("multi_step", W.multi_step, `${items} list items`);
  else if (SEQUENCE.test(text)) add("multi_step", W.multi_step, `ordered steps ("first … then")`);

  const constraints = uniq(text.match(CONSTRAINTS) ?? []);
  if (constraints.length >= 2) add("constraints", W.constraints, constraints.join(", "));

  if (CODE.test(text)) add("code", W.code, "code or code-like syntax");
  if (MATH.test(text)) add("math", W.math, "arithmetic or a calculation");

  if ((input.turns ?? 0) >= 6) add("long_conversation", W.long_conversation, `${input.turns} messages`);

  const score = round(Math.min(1, signals.reduce((n, s) => n + s.weight, 0)));
  const level: ComplexityLevel = score >= opts.complexityThreshold ? "complex" : score >= 0.2 ? "moderate" : "simple";
  return { score, level, threshold: opts.complexityThreshold, signals };
}

/** "complexity 0.6 ≥ 0.5: reasoning (cues: compare, explain); multi_question (asks what + how)" */
export const describeComplexity = (c: ComplexityAssessment) =>
  `complexity ${c.score} ${c.score >= c.threshold ? "≥" : "<"} ${c.threshold}` +
  (c.signals.length ? `: ${c.signals.map((s) => `${s.id} (${s.detail})`).join("; ")}` : ": no complexity signals");
