/**
 * auto-cascade: start on the fast tier, read its header, and move up to the strong tier only if
 * the fast model looks unsure. The heuristic and the classifier guess before any model has run;
 * the cascade decides on evidence from the fast model's own answer.
 *
 * It fits the gateway's one-commit-point rule: the support header ({"intent","confidence"}###) is
 * validated before any answer text reaches the client, so throwing away a fast attempt at that
 * point splices nothing. The cost is the fast attempt's tokens and its time to the header, paid
 * only on escalated requests.
 *
 * Pure: given the header and the retrieval result, should this attempt escalate, and why?
 */

export interface CascadeInput {
  /** intent from the model's header */
  intent: string;
  /** the combined confidence (support.ts confidenceOf), 0–1 */
  confidence: number;
  /** the retriever's top intent */
  topIntent: string | null;
  /** escalate when the combined confidence is below this */
  escalateBelow: number;
}

/** the reason to escalate, or null to keep the fast model's answer */
export function cascadeEscalation(i: CascadeInput): string | null {
  const why: string[] = [];
  // "unknown" from the small model gets a second opinion; the strong model can still refuse
  if (i.intent === "unknown") why.push("fast model said the message is out of scope");
  else {
    if (i.confidence < i.escalateBelow) why.push(`confidence ${i.confidence} < ${i.escalateBelow}`);
    if (i.topIntent && i.intent !== i.topIntent) why.push(`fast model said ${i.intent}, retrieval says ${i.topIntent}`);
  }
  return why.length ? why.join("; ") : null;
}
