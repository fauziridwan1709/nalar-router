/**
 * auto-smart: a small model reads the message and says whether it needs the strong tier.
 *
 * The heuristic in complexity.ts only sees surface features (length, cue words, lists). It misses a
 * hard question phrased plainly ("my refund never came and now I was charged again, what do I do
 * first?") and it escalates a long but simple message. A classifier reads meaning. It costs one
 * short call to the fast model (about 250 tokens, ~0.5 s on Groq), so it runs only when the
 * caller picks `auto-smart`, only when the plan has a strong tier to escalate to, and the router
 * falls back to the heuristic whenever the call fails, times out or returns something unparseable.
 *
 * This file is pure: the prompt, and the parser for the model's reply.
 */
import type { ChatMessage } from "../types.js";

export type ComplexityLabel = "simple" | "complex";

export interface RouterVerdict {
  label: ComplexityLabel;
  /** the classifier's own confidence, 0–1 */
  confidence: number;
  /** a few words of why, from the model; shown in the routing reason */
  why: string;
}

/** what planRoute is told about the classification, stored with the route (no message text) */
export type ClassifierResult =
  | ({ status: "ok"; backend: string; latencyMs: number } & RouterVerdict)
  | { status: "failed"; backend?: string; latencyMs?: number; error: string };

// v2. v1 named "an angry dispute" and "a long or tangled situation" as complex, and escalated 4 of 34
// plain FAQ questions ("i dont know how to check the early exit penalty": "requires explanation").
// v2 says what a small model handles well first; on the same 42 messages it escalated none of them
// and caught the same 5 of 7 complex ones (EVALUATION.md, router modes).
const SYSTEM = `You are the router of a customer-support LLM gateway. A small model answers one support request well from the FAQ, even when the message is vague, misspelled, emotional, or asks how to do something. Send a message to the large model only when answering it takes real reasoning.
"complex": two or more distinct requests or problems that must be untangled, a comparison or recommendation, a calculation, code, or a situation where the order of steps or a judgement call matters.
"simple": everything else, including one request said angrily or at length.
Placeholders like {{Customer Email}} stand for masked personal data; ignore them.
Reply with JSON only: {"label":"simple"|"complex","confidence":<0-1>,"why":"<at most 8 words>"}`;

/** the message goes in as data, inside a fence, so an instruction in it is less likely to be followed */
export function buildClassifierMessages(text: string, maxChars = 2_000): ChatMessage[] {
  const body = text.length > maxChars ? `${text.slice(0, maxChars)} …[truncated]` : text;
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Message to classify:\n<<<\n${body}\n>>>` },
  ];
}

/** the first {...} in the reply, checked field by field; null if it isn't a usable verdict */
export function parseVerdict(raw: string): RouterVerdict | null {
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  let j: unknown;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const label = typeof o.label === "string" ? o.label.trim().toLowerCase() : "";
  if (label !== "simple" && label !== "complex") return null;
  const c = Number(o.confidence);
  const confidence = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5;
  // model text ends up in a stored, displayed reason: one short line, no braces
  const why = typeof o.why === "string" ? o.why.replace(/[\s{}]+/g, " ").trim().slice(0, 80) : "";
  return { label, confidence: Math.round(confidence * 100) / 100, why };
}
