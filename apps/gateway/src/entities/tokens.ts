/**
 * Token estimation, used ONLY when a provider does not report usage
 * (mock backend, aborted streams, pre-admission budgeting). Rows that rely on it are
 * marked usage_source='estimated' so they are never confused with provider counts.
 * ~4 chars/token is the usual English heuristic for BPE tokenizers; we measured it
 * against provider-reported usage in the eval (see docs/REPORT.md).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: { role: string; content: string }[]): number {
  // +4 per message for role/formatting overhead, +2 for the assistant priming
  return messages.reduce((n, m) => n + 4 + estimateTokens(m.content), 2);
}
