/**
 * Request size limits. The HTTP schemas enforce them and the console shows them, so both read
 * them from here. Characters, not tokens: they bound the body before anything is estimated.
 */
export const LIMITS = {
  /** one customer message to /v1/support/answer */
  supportMessageChars: 2_000,
  /** one message to /v1/chat/completions */
  chatMessageChars: 16_000,
  /** all messages of one chat request together */
  chatTotalChars: 32_000,
  chatMaxMessages: 50,
  /** the most a caller may ask for in max_tokens / max_completion_tokens */
  maxCompletionTokens: 4_096,
  /** OpenAI leaves max_tokens open; the gateway reserves this much when it isn't sent */
  chatDefaultCompletionTokens: 1_024,
} as const;
