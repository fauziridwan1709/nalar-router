/** Backend status, the model catalogue, fault injection and the committed eval runs. */
import type { User } from "../entities/auth/user.js";
import { GatewayError } from "../entities/errors.js";
import { AUTO_MODELS } from "../entities/routing/policy.js";
import type { Tenant } from "../entities/types.js";
import { isOperator, type Actor } from "./access.js";
import type { GatewayDeps } from "./deps.js";
import type { ChaosSettings } from "./ports/operations.js";

/** every backend with its config, health, breaker and fault-injection settings (operators) */
export function backendStatus(deps: GatewayDeps) {
  return deps.backends.map((b) => ({
    id: b.config.id,
    tier: b.config.tier,
    model: b.config.model,
    enabled: b.config.enabled,
    location: b.config.location,
    health: deps.health.get(b.config.id),
    contextWindow: b.config.contextWindow ?? null,
    priceInPerM: b.config.priceInPerM,
    priceOutPerM: b.config.priceOutPerM,
    firstTokenTimeoutMs: b.config.firstTokenTimeoutMs,
    totalTimeoutMs: b.config.totalTimeoutMs,
    breaker: deps.breaker.snapshot(b.config.id),
    chaos: deps.chaos.get(b.config.id),
  }));
}

/** what a console user sees: tenants get availability, not probe internals, breaker errors or fault-injection settings */
export function backendStatusFor(deps: GatewayDeps, user: User) {
  const full = backendStatus(deps);
  if (isOperator(user)) return full;
  return full.map((b) => ({
    id: b.id,
    tier: b.tier,
    model: b.model,
    enabled: b.enabled,
    location: b.location,
    contextWindow: b.contextWindow,
    health: b.health
      ? { label: b.health.label, availability: b.health.availability, checkedAt: b.health.checkedAt }
      : undefined,
    breaker: { state: b.breaker.state },
  }));
}

/** which backends exist, whether they're online, and whether this tenant's plan may use them */
export function backendsForTenant(deps: GatewayDeps, tenant: Tenant) {
  return deps.backends.map((b) => ({
    id: b.config.id,
    tier: b.config.tier,
    model: b.config.model,
    location: b.config.location,
    allowedForTenant: tenant.allowedTiers.includes(b.config.tier),
    health: deps.health.get(b.config.id),
    breaker: deps.breaker.snapshot(b.config.id).state,
  }));
}

/** OpenAI's model list: the router aliases first, then the tiers and backends this tenant's plan may use */
export function modelsForTenant(deps: GatewayDeps, tenant: Tenant) {
  const created = Math.floor(deps.startedAt / 1000);
  const usable = deps.backends.filter((b) => b.config.enabled && tenant.allowedTiers.includes(b.config.tier));
  const ids = [
    ...Object.keys(AUTO_MODELS),
    ...new Set(usable.map((b) => b.config.tier)),
    ...usable.map((b) => b.config.id),
  ];
  return {
    object: "list" as const,
    data: ids.map((id) => ({ id, object: "model" as const, created, owned_by: "nalar-router" })),
  };
}

/** `actor` is null for the admin-token route, which isn't audited */
export function setFaultInjection(
  deps: GatewayDeps,
  actor: Actor | null,
  backendId: string,
  settings: Partial<ChaosSettings>,
) {
  if (!deps.backends.some((b) => b.config.id === backendId))
    throw new GatewayError(404, "not_found", "Backend not found.");
  if (actor)
    deps.audit.record({
      tenantId: null,
      actor: actor.user,
      action: "chaos.set",
      target: backendId,
      ip: actor.ip,
      meta: settings,
    });
  return deps.chaos.set(backendId, settings);
}

/** clears every fault and resets the circuit breaker */
export function clearFaultInjection(deps: GatewayDeps, actor: Actor | null) {
  deps.chaos.clear();
  deps.breaker.reset();
  if (actor) deps.audit.record({ tenantId: null, actor: actor.user, action: "chaos.clear", ip: actor.ip });
  return { ok: true };
}

export const evalRuns = (deps: GatewayDeps) => deps.evals.list();
