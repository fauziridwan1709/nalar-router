/**
 * Context windows: a backend can serve a request only if the prompt plus the answer budget fit.
 * The prompt size is the chars/4 estimate, which reads 6–17% high against provider counts
 * (docs/REPORT.md §5), so a request near the limit is refused rather than truncated by the provider.
 */
import { GatewayError } from "../errors.js";
import type { BackendConfig } from "../types.js";

export interface ContextNeed {
  /** estimated tokens of everything sent to the model */
  promptTokens: number;
  /** tokens reserved for the answer (max_tokens, or the capability's own budget) */
  completionTokens: number;
}

export const contextNeeded = (n: ContextNeed) => n.promptTokens + n.completionTokens;

/** true when the backend has no declared window, or the request fits in it */
export const fitsContext = (c: Pick<BackendConfig, "contextWindow">, n: ContextNeed) =>
  c.contextWindow === undefined || contextNeeded(n) <= c.contextWindow;

/** 400 context_length_exceeded, worded like OpenAI's, with the numbers in `details` */
export function contextLengthExceeded(model: string, contextWindow: number, n: ContextNeed) {
  return new GatewayError(
    400,
    "context_length_exceeded",
    `"${model}" accepts up to ${contextWindow.toLocaleString("en-US")} tokens, but this request needs about ` +
      `${contextNeeded(n).toLocaleString("en-US")} (${n.promptTokens.toLocaleString("en-US")} in the messages, ` +
      `${n.completionTokens.toLocaleString("en-US")} reserved for the answer). Shorten the messages, lower max_tokens, or pick a model with a larger context.`,
    { model, contextWindow, promptTokens: n.promptTokens, completionTokens: n.completionTokens },
  );
}
