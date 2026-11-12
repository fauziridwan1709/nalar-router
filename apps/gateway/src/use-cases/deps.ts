/**
 * What the use cases need from the outside world, as contracts. The composition root
 * (main/container.ts) builds an object that satisfies them; tests build one with fakes. Use cases
 * never see the database, Express or the config loader directly.
 *
 * - AppDeps: the capability path (support answer, chat completion).
 * - GatewayDeps: AppDeps plus what the console, admin and key-management use cases need.
 */
import type { CircuitBreaker } from "../entities/routing/breaker.js";
import type { RouteOptions } from "../entities/routing/policy.js";
import type { Bm25Index } from "../entities/support/retrieval.js";
import type { PromptVersion } from "../entities/support/prompt.js";
import type { Backend } from "./ports/backend.js";
import type { MeteringStore, QuotaStore } from "./ports/stores.js";
import type { FailureLimiter } from "../entities/auth/failureLimiter.js";
import type { Role } from "../entities/auth/rbac.js";
import type { ApiKeyRepository } from "./ports/apiKeys.js";
import type { AuditLog, PasswordVerifier, SessionStore, UserDirectory } from "./ports/identity.js";
import type { EvalResults, FaultInjection, HealthReader } from "./ports/operations.js";
import type { Reporting } from "./ports/reporting.js";
import type { TenantRepository } from "./ports/tenants.js";

export interface SupportSettings {
  topK: number;
  /** retrieved entries shown to the model */
  contextK: number;
  /** below this lexical coverage a short message is out of scope (no model call) */
  minCoverage: number;
  /** the coverage gate applies only to messages with at most this many terms */
  gateMaxTerms: number;
  /** final confidence below this → refuse instead of answering */
  refuseBelow: number;
  maxAnswerTokens: number;
  reasoningExtraTokens: number;
  defaultPromptVersion: PromptVersion;
}

export interface ClassifierSettings {
  /** the backend that classifies for auto-smart; falls back to the first enabled fast-tier backend */
  backendId: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface AppDeps {
  config: { routing: RouteOptions; support: SupportSettings; classifier: ClassifierSettings };
  backends: Backend[];
  breaker: CircuitBreaker;
  kb: Bm25Index;
  intents: string[];
  quota: QuotaStore;
  metering: MeteringStore;
}

/** a seeded demo account, listed on the sign-in page in demo mode */
export interface DemoAccount {
  email: string;
  role: Role;
  tenantId: string;
  /** null when the password came from an env var: somebody's real choice is never echoed */
  password: string | null;
}

export interface GatewayDeps extends AppDeps {
  tenants: TenantRepository;
  apiKeys: ApiKeyRepository;
  users: UserDirectory;
  sessions: SessionStore;
  passwords: PasswordVerifier;
  audit: AuditLog;
  reporting: Reporting;
  chaos: FaultInjection;
  health: HealthReader;
  evals: EvalResults;
  /** failed sign-ins, counted per account and per IP */
  signInLimits: { perAccount: FailureLimiter; perIp: FailureLimiter };
  /** empty unless demo mode is on */
  demoAccounts: DemoAccount[];
  /** process start, used as `created` in /v1/models */
  startedAt: number;
}
