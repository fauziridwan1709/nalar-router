/**
 * Routing policy: which backends, in which order, for this request.
 *
 * Rules (in priority order):
 *  1. Tenant entitlement – only backends whose tier is in the tenant's plan are
 *     candidates. Asking for a tier/backend you don't have = 403, not a silent swap.
 *  2. Explicit hint – caller may pin a tier ("fast"/"strong"/"local"/"degraded") or
 *     a backend id; it becomes the primary, the rest of the default order follows as
 *     fallback.
 *  3. Auto – default to the FAST tier (cheapest, lowest latency). Escalate to the
 *     STRONG tier only when there is evidence the cheap model is likely to struggle:
 *       a) long input (> routing.longQueryTokens), or
 *       b) retrieval is ambiguous (top intent's vote share < routing.ambiguousVoteShare)
 *     On the support task the KB answer usually does the heavy lifting, so paying for
 *     the big model on every request buys little; we spend it where it matters.
 *  4. Fallback order after the primary: remaining real tiers, then the local model,
 *     then the extractive "degraded" backend (always available, zero cost, grounded).
 *  5. Backends with an open circuit breaker are moved out of the chain at execution
 *     time (recorded as `skipped_circuit_open`).
 */
import type { Backend } from "../backends/types.js";
import type { Tier } from "../config.js";
import type { Tenant } from "../tenants.js";
import { GatewayError } from "../errors.js";

export interface RouteSignals {
  queryTokens: number;
  /** support only */
  retrievalTopShare?: number;
  hint?: string;
}

export interface RoutePlan {
  chain: Backend[];
  rule: string;
  reason: string;
  signals: RouteSignals & { allowedTiers: Tier[] };
}

const TIER_ORDER_FAST_FIRST: Tier[] = ["fast", "strong", "local", "degraded"];
const TIER_ORDER_STRONG_FIRST: Tier[] = ["strong", "fast", "local", "degraded"];

export function planRoute(
  backends: Backend[],
  tenant: Tenant,
  signals: RouteSignals,
  opts: { longQueryTokens: number; ambiguousVoteShare: number },
): RoutePlan {
  const enabled = backends.filter((b) => b.config.enabled);
  const allowed = enabled.filter((b) => tenant.allowedTiers.includes(b.config.tier));
  const sig = { ...signals, allowedTiers: tenant.allowedTiers };
  if (!allowed.length) {
    throw new GatewayError(503, "no_backend_available", "No model backend is available for this tenant's plan.");
  }

  const order = (tiers: Tier[]) =>
    tiers.flatMap((t) => allowed.filter((b) => b.config.tier === t));

  const hint = signals.hint && signals.hint !== "auto" ? signals.hint : null;
  if (hint) {
    const byId = enabled.find((b) => b.config.id === hint);
    const byTier = enabled.filter((b) => b.config.tier === hint);
    const wanted = byId ? [byId] : byTier;
    if (!wanted.length) {
      throw new GatewayError(400, "unknown_model", `Unknown or disabled model/tier "${hint}".`, {
        available: ["auto", ...new Set(enabled.map((b) => b.config.tier)), ...enabled.map((b) => b.config.id)],
      });
    }
    const permitted = wanted.filter((b) => tenant.allowedTiers.includes(b.config.tier));
    if (!permitted.length) {
      throw new GatewayError(403, "model_not_allowed", `Your plan (${tenant.plan}) does not include "${hint}".`, {
        allowedTiers: tenant.allowedTiers,
      });
    }
    const rest = order(TIER_ORDER_FAST_FIRST).filter((b) => !permitted.includes(b));
    return {
      chain: [...permitted, ...rest],
      rule: "explicit_hint",
      reason: `caller pinned "${hint}"; fallback follows default order`,
      signals: sig,
    };
  }

  const reasons: string[] = [];
  if (signals.queryTokens > opts.longQueryTokens) reasons.push(`long query (${signals.queryTokens} > ${opts.longQueryTokens} tokens)`);
  if (signals.retrievalTopShare !== undefined && signals.retrievalTopShare < opts.ambiguousVoteShare)
    reasons.push(`ambiguous retrieval (top intent share ${signals.retrievalTopShare.toFixed(2)} < ${opts.ambiguousVoteShare})`);

  const wantStrong = reasons.length > 0;
  const hasStrong = allowed.some((b) => b.config.tier === "strong");
  const planHasStrong = tenant.allowedTiers.includes("strong");
  const chain = order(wantStrong ? TIER_ORDER_STRONG_FIRST : TIER_ORDER_FAST_FIRST);

  let rule: string;
  let reason: string;
  if (wantStrong && hasStrong) {
    rule = "auto_escalate_strong";
    reason = `escalated to strong tier: ${reasons.join("; ")}`;
  } else if (wantStrong && !planHasStrong) {
    rule = "auto_escalate_denied_by_plan";
    reason = `would escalate (${reasons.join("; ")}) but plan "${tenant.plan}" has no strong tier`;
  } else if (wantStrong) {
    rule = "auto_escalate_unavailable";
    reason = `would escalate (${reasons.join("; ")}) but no strong-tier backend is enabled`;
  } else {
    rule = "auto_default_fast";
    reason = "short query with unambiguous retrieval → cheapest/fastest tier";
  }
  if (chain[0]?.config.tier !== (wantStrong && hasStrong ? "strong" : "fast")) {
    reason += `; preferred tier unavailable, starting at ${chain[0].config.id}`;
  }
  return { chain, rule, reason, signals: sig };
}
