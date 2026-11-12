/**
 * Routing policy: which backends, in which order, for this request.
 *
 * Rules (in priority order):
 *  1. Tenant entitlement – only backends whose tier is in the tenant's plan are
 *     candidates. Asking for a tier/backend you don't have = 403, not a silent swap.
 *  2. Explicit hint – caller may pin a tier ("fast"/"strong"/"local"/"degraded") or
 *     a backend id; it becomes the primary, the rest of the default order follows as
 *     fallback.
 *  3. Auto – three router modes, picked with the model name:
 *     - `auto` (heuristic): default to the FAST tier (cheapest, lowest latency). Escalate to the
 *       STRONG tier only when the query looks complex: assessComplexity (complexity.ts) scores
 *       length, retrieval ambiguity, multiple questions, reasoning cues, multi-step structure,
 *       constraints, code, math and conversation length, and the router escalates when the
 *       score reaches routing.complexityThreshold. Free, instant, replayable.
 *     - `auto-smart` (classifier): a short call to the fast model labels the message simple or
 *       complex (classifier.ts); complex, or ambiguous retrieval, starts on strong. The call is
 *       made after admission (it is metered); if it fails or is unsure, the heuristic decides.
 *     - `auto-cascade` (support only): always start on fast; if the fast model's header shows doubt
 *       a better model could remove (cascade.ts), drop that attempt before anything is streamed
 *       and move up to strong. Chat
 *       has no header, so chat requests asking for it are routed by the heuristic.
 *     On the support task the KB answer usually does the heavy lifting, so paying for the big
 *     model on every request buys little; we spend it where it matters.
 *  4. Fallback order after the primary: remaining real tiers, then the local model,
 *     then the extractive "degraded" backend (always available, zero cost, grounded).
 *  5. Backends with an open circuit breaker are moved out of the chain at execution
 *     time (recorded as `skipped_circuit_open`).
 */
import type { RoutableBackend, Tenant, Tier } from "../types.js";
import { GatewayError } from "../errors.js";
import { assessComplexity, describeComplexity, type ComplexityAssessment } from "./complexity.js";
import type { ClassifierResult } from "./classifier.js";
import { contextLengthExceeded, fitsContext, type ContextNeed } from "./context.js";

/** heuristic = `auto`; the model names are what callers send */
export type AutoMode = "heuristic" | "smart" | "cascade";
export const AUTO_MODELS: Record<string, AutoMode> = { auto: "heuristic", "auto-smart": "smart", "auto-cascade": "cascade" };
export const isAutoModel = (m: string | undefined) => m === undefined || m in AUTO_MODELS;

export interface RouteSignals {
  /** estimated tokens of the newest user turn */
  queryTokens: number;
  /** the newest user turn, for the complexity signals (masked if the PII guardrail masked it) */
  text?: string;
  /** chat only: messages in the conversation */
  turns?: number;
  /** support only */
  retrievalTopShare?: number;
  hint?: string;
  /** the capability can run auto-cascade (support: it has a header to judge) */
  cascadeCapable?: boolean;
  /** auto-smart: the classification, once it has run */
  classifier?: ClassifierResult;
  /** prompt and answer size: backends whose context window can't hold them are left out of the chain */
  context?: ContextNeed;
}

export interface RouteOptions {
  /** queries longer than this (estimated tokens) go to the strong tier */
  longQueryTokens: number;
  /** retrieval vote share below this = ambiguous → strong tier */
  ambiguousVoteShare: number;
  /** complexity score (0–1) at or above which auto routing starts at the strong tier */
  complexityThreshold: number;
  /** auto-smart: a classifier verdict below this confidence is ignored and the heuristic decides */
  classifierMinConfidence: number;
  /** auto-cascade: the fast model's own header confidence below this escalates to strong */
  cascadeModelConfidenceBelow: number;
}

export interface RoutePlan<B extends RoutableBackend = RoutableBackend> {
  chain: B[];
  rule: string;
  reason: string;
  /** "pinned" for an explicit hint; otherwise the auto mode that decided */
  mode: AutoMode | "pinned";
  /** auto-smart only: true until the classifier has run (call planRoute again with `classifier`) */
  needsClassifier?: boolean;
  signals: Omit<RouteSignals, "text" | "cascadeCapable"> & { allowedTiers: Tier[]; complexity?: ComplexityAssessment };
}

const TIER_ORDER_FAST_FIRST: Tier[] = ["fast", "strong", "local", "degraded"];
const TIER_ORDER_STRONG_FIRST: Tier[] = ["strong", "fast", "local", "degraded"];

export function planRoute<B extends RoutableBackend>(
  backends: B[],
  tenant: Tenant,
  signals: RouteSignals,
  opts: RouteOptions,
): RoutePlan<B> {
  const enabled = backends.filter((b) => b.config.enabled);
  const allowed = enabled.filter((b) => tenant.allowedTiers.includes(b.config.tier));
  // the text itself isn't kept: route reasons are stored and shown, and the text may be long
  const { text: _text, cascadeCapable: _cc, ...kept } = signals;
  const sig: RoutePlan["signals"] = { ...kept, allowedTiers: tenant.allowedTiers };
  if (!allowed.length) {
    throw new GatewayError(503, "no_backend_available", "No model backend is available for this tenant's plan.");
  }

  // context window: a backend that can't hold the prompt plus the answer budget is never tried,
  // not even as a fallback, so the provider never truncates or rejects it mid-chain
  const need = signals.context;
  const fits = (b: B) => !need || fitsContext(b.config, need);
  const tooSmall = allowed.filter((b) => !fits(b));
  const usable = allowed.filter(fits);
  const order = (tiers: Tier[]) =>
    tiers.flatMap((t) => usable.filter((b) => b.config.tier === t));
  const contextNote = tooSmall.length ? `; skipped ${tooSmall.map((b) => b.config.id).join(", ")} (context window too small)` : "";

  const hint = signals.hint && !isAutoModel(signals.hint) ? signals.hint : null;
  if (hint) {
    const byId = enabled.find((b) => b.config.id === hint);
    const byTier = enabled.filter((b) => b.config.tier === hint);
    const wanted = byId ? [byId] : byTier;
    if (!wanted.length) {
      throw new GatewayError(400, "unknown_model", `Unknown or disabled model/tier "${hint}".`, {
        available: [...Object.keys(AUTO_MODELS), ...new Set(enabled.map((b) => b.config.tier)), ...enabled.map((b) => b.config.id)],
      });
    }
    const onPlan = wanted.filter((b) => tenant.allowedTiers.includes(b.config.tier));
    if (!onPlan.length) {
      throw new GatewayError(403, "model_not_allowed", `Your plan (${tenant.plan}) does not include "${hint}".`, {
        allowedTiers: tenant.allowedTiers,
      });
    }
    // a pinned model that can't hold the request is an error, not a silent switch to another model
    const permitted = onPlan.filter(fits);
    if (!permitted.length) {
      const largest = onPlan.reduce((a, b) => ((b.config.contextWindow ?? 0) > (a.config.contextWindow ?? 0) ? b : a));
      throw contextLengthExceeded(hint, largest.config.contextWindow!, need!);
    }
    const rest = order(TIER_ORDER_FAST_FIRST).filter((b) => !permitted.includes(b));
    return {
      chain: [...permitted, ...rest],
      rule: "explicit_hint",
      reason: `caller pinned "${hint}"; fallback follows default order${contextNote}`,
      mode: "pinned",
      signals: sig,
    };
  }

  if (!usable.length) {
    const largest = tooSmall.reduce((a, b) => ((b.config.contextWindow ?? 0) > (a.config.contextWindow ?? 0) ? b : a));
    throw contextLengthExceeded(largest.config.id, largest.config.contextWindow!, need!);
  }

  const complexity = assessComplexity(
    { text: signals.text ?? "", queryTokens: signals.queryTokens, turns: signals.turns, retrievalTopShare: signals.retrievalTopShare },
    opts,
  );
  sig.complexity = complexity;
  const heuristic = describeComplexity(complexity);
  const heuristicWantsStrong = complexity.score >= opts.complexityThreshold;
  const hasStrong = usable.some((b) => b.config.tier === "strong");
  const planHasStrong = tenant.allowedTiers.includes("strong");
  const requested = AUTO_MODELS[signals.hint ?? "auto"] ?? "heuristic";

  /** fast first, or strong first; the rule says which and why */
  const decide = (mode: AutoMode, prefix: string, wantStrong: boolean, why: string, note = ""): RoutePlan<B> => {
    const chain = order(wantStrong ? TIER_ORDER_STRONG_FIRST : TIER_ORDER_FAST_FIRST);
    let rule: string;
    let reason: string;
    if (wantStrong && hasStrong) {
      rule = `${prefix}_escalate_strong`;
      reason = `escalated to strong tier: ${why}`;
    } else if (wantStrong && !planHasStrong) {
      rule = `${prefix}_escalate_denied_by_plan`;
      reason = `would escalate (${why}) but plan "${tenant.plan}" has no strong tier`;
    } else if (wantStrong) {
      rule = `${prefix}_escalate_unavailable`;
      reason = `would escalate (${why}) but no strong-tier backend is enabled`;
    } else {
      rule = `${prefix}_default_fast`;
      reason = `simple enough for the fast tier: ${why}`;
    }
    if (chain[0]?.config.tier !== (wantStrong && hasStrong ? "strong" : "fast")) {
      reason += `; preferred tier unavailable, starting at ${chain[0].config.id}`;
    }
    return { chain, rule, reason: note + reason + contextNote, mode, signals: sig };
  };

  if (requested === "cascade") {
    if (!signals.cascadeCapable) {
      return decide("heuristic", "auto", heuristicWantsStrong, heuristic, "auto-cascade needs the support header, so the heuristic routed this: ");
    }
    if (!hasStrong) {
      return decide("cascade", "cascade", false, `no strong tier to escalate to (${planHasStrong ? "none enabled" : `plan "${tenant.plan}"`}), so the cascade stays on fast; ${heuristic}`);
    }
    return {
      chain: order(TIER_ORDER_FAST_FIRST),
      rule: "cascade_start_fast",
      reason: `cascade: start on fast; escalate to strong before streaming if the fast model says unknown, rates itself below ${opts.cascadeModelConfidenceBelow}, or disagrees with retrieval and would be refused`,
      mode: "cascade",
      signals: sig,
    };
  }

  if (requested === "smart") {
    // ambiguous retrieval is evidence the classifier can't see, so it still escalates on its own
    const ambiguous = complexity.signals.find((s) => s.id === "ambiguous_intent");
    if (!hasStrong) {
      return decide("smart", "smart", false, `no strong tier to escalate to, classifier skipped; ${heuristic}`);
    }
    const c = signals.classifier;
    if (!c) {
      // provisional: the classifier runs after admission, then planRoute is called again with it
      return { ...decide("smart", "smart", heuristicWantsStrong, heuristic), rule: "smart_pending", needsClassifier: true };
    }
    if (c.status === "failed" || c.confidence < opts.classifierMinConfidence) {
      const why = c.status === "failed" ? `classifier failed (${c.error})` : `classifier unsure (${c.label} at ${c.confidence} < ${opts.classifierMinConfidence})`;
      return { ...decide("smart", "smart", heuristicWantsStrong, heuristic, `${why}, so the heuristic decided: `), rule: "smart_fallback_heuristic" };
    }
    const why = `classifier says ${c.label} (${c.confidence}${c.why ? `, "${c.why}"` : ""})` + (ambiguous ? `; ${ambiguous.id} (${ambiguous.detail})` : "");
    return decide("smart", "smart", c.label === "complex" || !!ambiguous, why);
  }

  return decide("heuristic", "auto", heuristicWantsStrong, heuristic);
}
