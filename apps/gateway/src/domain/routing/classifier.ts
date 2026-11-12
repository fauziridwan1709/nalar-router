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

const SYSTEM = `You are the router of an LLM gateway. Decide whether the user's message needs a large model.
"complex": several requests in one, comparisons or trade-offs, reasoning, planning or prioritising, calculations, code, a long or tangled situation, or an angry dispute that needs careful handling.
"simple": one clear request a small model answers well from a FAQ (track an order, cancel, refund policy, change an address, reset a password), including vague one-liners.
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
