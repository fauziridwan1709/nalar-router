/**
 * Quota standing, from the usage the gateway reports. Tokens include what's reserved by requests
 * still running, as admission counts them. A tenant is "out" at 100% of either limit, or as soon
 * as its newest request was refused: each request reserves its prompt plus a minimum answer, so a
 * tenant can be refused below 100%.
 */
import type { TenantUsage } from "./models";

export type Level = "ok" | "near" | "out";

/** "near" from this share of either limit */
export const NEAR_LIMIT = 0.8;

export const share = (used: number, total: number) => (total ? Math.min(1, used / total) : 1);
/** tokens count what's metered plus what's reserved by requests still running, as admission does */
export const tokenShare = (u: TenantUsage) => share(u.tokenQuota - u.tokensRemaining, u.tokenQuota);
export const levelOf = (u: TenantUsage): Level => {
  const p = Math.max(tokenShare(u), share(u.requestsUsed, u.requestQuota));
  return p >= 1 || u.rejecting ? "out" : p >= NEAR_LIMIT ? "near" : "ok";
};
export const sharePct = (p: number) => (p > 0 && p < 0.01 ? "<1%" : `${Math.round(p * 100)}%`);
