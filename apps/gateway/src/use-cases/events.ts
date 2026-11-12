/** The shapes of events both capabilities emit, built in one place so they can't drift apart. */
import { publicAttemptError, type ErrorCode } from "../entities/errors.js";
import type { AttemptRecord } from "../entities/metering.js";
import type { RoutePlan } from "../entities/routing/policy.js";
import type { BackendError } from "../entities/errors.js";
import type { Backend } from "./ports/backend.js";

/** a finished attempt as the client sees it: provider error text stays in the database */
export const attemptEvent = (attempt: AttemptRecord) => ({
  ...attempt,
  status: attempt.outcome,
  error: attempt.error ? publicAttemptError(attempt.outcome) : attempt.error,
});

/** the routing decision, stored with the request and shown in the console */
export const routeEvent = (plan: RoutePlan<Backend>) => ({
  rule: plan.rule,
  reason: plan.reason,
  mode: plan.mode,
  chain: plan.chain.map((b) => b.config.id),
  signals: plan.signals,
});
export type RouteReason = ReturnType<typeof routeEvent>;

/** how a run that produced no complete answer ends: the client left, the stream broke, or nothing worked */
export function failureOf(error: BackendError, committed: boolean) {
  if (error.kind === "aborted") {
    return { code: "client_aborted" as ErrorCode, outcome: "client_aborted" as const, httpStatus: 499, message: "Client disconnected." };
  }
  if (committed) {
    return { code: "stream_interrupted" as ErrorCode, outcome: "partial" as const, httpStatus: 502, message: "The answer was interrupted." };
  }
  return { code: "all_backends_failed" as ErrorCode, outcome: "failed_all_backends" as const, httpStatus: 502, message: "All model backends failed." };
}
