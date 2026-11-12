/**
 * Request limits, checked in the playground before a request is sent. The gateway enforces the
 * same limits (and returns 400 `invalid_request` or `context_length_exceeded`); this check only
 * saves a round trip and explains the problem next to the input.
 *
 * Token counts use the gateway's own estimate (4 characters per token), which reads a little high,
 * so a request the console accepts is one the gateway accepts too.
 */
import type { ConsoleConfig, PlaygroundEndpoint } from "./models";

export const estimateTokens = (text: string) => (text ? Math.ceil(text.length / 4) : 0);
/** +4 per message for role and formatting, +2 for the assistant priming, as the gateway counts */
export const estimateMessagesTokens = (messages: { content: string }[]) =>
  messages.reduce((n, m) => n + 4 + estimateTokens(m.content), 2);

type Backend = ConsoleConfig["backends"][number];
const AUTO = new Set(["auto", "auto-smart", "auto-cascade"]);

/**
 * The context window a request will be checked against. A pinned backend: its own. A tier or an
 * auto mode: the largest among the backends the plan allows, because the gateway skips the
 * smaller ones. `null` means no limit (a backend without a declared window can take it).
 */
export function contextWindowFor(
  model: string,
  backends: Backend[],
  allowedTiers: string[],
): { window: number | null; label: string } {
  const usable = backends.filter((b) => b.enabled && allowedTiers.includes(b.tier));
  const byId = backends.find((b) => b.id === model);
  const candidates = byId ? [byId] : AUTO.has(model) ? usable : usable.filter((b) => b.tier === model);
  if (!candidates.length || candidates.some((b) => b.contextWindow === null))
    return { window: null, label: byId?.id ?? model };
  const largest = candidates.reduce((a, b) => (b.contextWindow! > a.contextWindow! ? b : a));
  return { window: largest.contextWindow, label: byId ? byId.id : largest.id };
}

export interface PlaygroundInput {
  endpoint: PlaygroundEndpoint;
  message: string;
  /** chat only */
  system: string;
  model: string;
  includeReasoning: boolean;
}

export interface PlaygroundCheck {
  /** what stops the request, in words for the user; empty when it can be sent */
  problems: string[];
  /** characters of the message box and its limit */
  chars: number;
  maxChars: number;
  /** estimated tokens sent; for support only the message (the gateway adds instructions and KB context) */
  promptTokens: number;
  /** tokens reserved for the answer */
  completionTokens: number;
  window: number | null;
  windowLabel: string;
}

const n = (x: number) => x.toLocaleString("en-US");

export function checkPlayground(
  input: PlaygroundInput,
  cfg: Pick<ConsoleConfig, "backends" | "limits">,
  allowedTiers: string[],
): PlaygroundCheck {
  const L = cfg.limits;
  const problems: string[] = [];
  const { window, label } = contextWindowFor(input.model, cfg.backends, allowedTiers);
  let promptTokens: number;
  let completionTokens: number;
  let maxChars: number;

  if (input.endpoint === "support") {
    maxChars = L.supportMessageChars;
    if (input.message.length > maxChars) problems.push(`The customer message is limited to ${n(maxChars)} characters.`);
    promptTokens = estimateTokens(input.message);
    completionTokens = L.supportAnswerTokens + (input.includeReasoning ? L.supportReasoningExtraTokens : 0);
  } else {
    maxChars = L.chatMessageChars;
    if (input.message.length > maxChars) problems.push(`The user message is limited to ${n(maxChars)} characters.`);
    if (input.system.length > maxChars) problems.push(`The system prompt is limited to ${n(maxChars)} characters.`);
    const total = input.message.length + input.system.length;
    if (total > L.chatTotalChars)
      problems.push(
        `System prompt and message together are limited to ${n(L.chatTotalChars)} characters (now ${n(total)}).`,
      );
    const messages = [...(input.system.trim() ? [{ content: input.system }] : []), { content: input.message }];
    promptTokens = estimateMessagesTokens(messages);
    completionTokens = L.chatDefaultCompletionTokens;
  }

  if (window !== null && promptTokens + completionTokens > window) {
    problems.push(
      `"${label}" accepts up to ${n(window)} tokens, but this request needs about ${n(promptTokens + completionTokens)} ` +
        `(${n(promptTokens)} for the ${input.endpoint === "support" ? "message" : "messages"}, ${n(completionTokens)} reserved for the answer). ` +
        `Shorten it or pick a model with a larger context.`,
    );
  }
  return {
    problems,
    chars: input.message.length,
    maxChars,
    promptTokens,
    completionTokens,
    window,
    windowLabel: label,
  };
}
