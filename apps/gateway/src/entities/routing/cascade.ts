/**
 * auto-cascade: start on the fast tier, read its header, and move up to the strong tier only if
 * the fast model is the reason the request is in trouble. The heuristic and the classifier guess
 * before any model has run; the cascade decides on evidence from the fast model's own answer.
 *
 * It fits the gateway's one-commit-point rule: the support header ({"intent","confidence"}###) is
 * validated before any answer text reaches the client, so throwing away a fast attempt at that
 * point splices nothing. The cost is the fast attempt's tokens and its time to the header, paid
 * only on escalated requests.
 *
 * What counts as the fast model's fault. The combined confidence (support/confidence.ts) is
 * 0.45 × retrieval vote + 0.35 × coverage + 0.2 × the model's own confidence, so 80% of it comes
 * from retrieval and no model can change it. The first live run escalated on "combined < 0.75" and
 * that was wasted: when the fast model agreed with retrieval, its score sat within 0.002 of the
 * best any model could reach. So the cascade escalates only on doubt a better model can remove:
 *  - the fast model said `unknown` (a second opinion before refusing as out of scope),
 *  - its own confidence is low,
 *  - it disagrees with retrieval and would be refused, while a model that agrees could pass.
 * And never when even a perfect answer (retrieval's top intent, self-confidence 1) would still be
 * refused: then the strong model can't change the outcome and the fast model's refusal stands.
 *
 * Pure: given the header and the retrieval result, should this attempt escalate, and why?
 */

export interface CascadeInput {
  /** intent from the model's header */
  intent: string;
  /** the model's own confidence from the header, 0–1 */
  modelConfidence: number;
  /** the combined confidence for that intent, 0–1 */
  confidence: number;
  /** the combined confidence a model could reach at best: retrieval's top intent, self-confidence 1 */
  ceiling: number;
  /** the retriever's top intent */
  topIntent: string | null;
  /** the support refusal threshold (combined confidence below it is refused) */
  refuseBelow: number;
  /** escalate when the model's own confidence is below this */
  modelConfidenceBelow: number;
}

/** the reason to escalate, or null to keep the fast model's decision (answer or refusal) */
export function cascadeEscalation(i: CascadeInput): string | null {
  if (i.ceiling < i.refuseBelow) return null; // nobody can pass: retrieval alone keeps this below the bar
  if (i.intent === "unknown") return "fast model said the message is out of scope; asking for a second opinion";
  const why: string[] = [];
  if (i.modelConfidence < i.modelConfidenceBelow) why.push(`fast model's own confidence ${i.modelConfidence} < ${i.modelConfidenceBelow}`);
  if (i.topIntent && i.intent !== i.topIntent && i.confidence < i.refuseBelow) {
    why.push(`fast model said ${i.intent}, retrieval says ${i.topIntent}, so it would be refused (${i.confidence} < ${i.refuseBelow}; up to ${i.ceiling} is possible)`);
  }
  return why.length ? why.join("; ") : null;
}
