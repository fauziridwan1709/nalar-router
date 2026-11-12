/**
 * The support answer's confidence signal: how sure the gateway is that it understood the message.
 *
 *   confidence = 0.45 × retrieval vote + 0.35 × coverage + 0.20 × the model's own confidence
 *
 * - retrieval vote: the share of the top-k KB entries that carry the model's chosen intent
 * - coverage: how much of the message the knowledge base recognises at all
 * - model: the self-confidence the model wrote in its header
 *
 * 80% comes from retrieval, which the model can't talk up; the gateway refuses below a threshold.
 */
import { voteShareFor, type RetrievalResult } from "./retrieval.js";

export const CONFIDENCE_WEIGHTS = { vote: 0.45, coverage: 0.35, model: 0.2 } as const;

export interface Confidence {
  value: number;
  label: "high" | "medium" | "low";
  components: { retrievalVote: number; coverage: number; model: number };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function confidenceOf(retrieval: RetrievalResult, intent: string, modelConfidence: number): Confidence {
  const vote = voteShareFor(retrieval, intent);
  const w = CONFIDENCE_WEIGHTS;
  const value = w.vote * vote + w.coverage * retrieval.coverage + w.model * modelConfidence;
  return {
    value: round3(value),
    label: value >= 0.75 ? "high" : value >= 0.5 ? "medium" : "low",
    components: { retrievalVote: round3(vote), coverage: round3(retrieval.coverage), model: round3(modelConfidence) },
  };
}
