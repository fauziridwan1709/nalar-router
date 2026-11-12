/**
 * The console's vocabulary: what the gateway's console API returns and accepts, as plain types.
 * No behaviour and no I/O; every other layer imports these.
 */

export type Role = "operator" | "owner" | "developer" | "viewer";
export type Permission =
  | "dashboard:read" | "requests:read" | "usage:read" | "evals:read" | "backends:read" | "playground:run"
  | "keys:read" | "keys:create" | "keys:revoke_own" | "keys:revoke_any" | "audit:read" | "tenants:all" | "quota:reset" | "chaos:write"
  | "governance:read" | "governance:write" | "members:read";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenant: { id: string; name: string; plan: string } | null;
  permissions: Permission[];
}

export interface ConsoleTenant {
  id: string;
  name: string;
  plan: string;
  allowedTiers: string[];
  /** company facts the gateway uses to fill {{…}} placeholders */
  profile: Record<string, string>;
  /** what the PII guardrail does with personal data in this tenant's requests */
  piiMode: PiiMode;
}

export type PiiMode = "mask" | "block" | "off";
export interface ConsoleConfig {
  tenants: ConsoleTenant[];
  /** contextWindow: max tokens in + out per call, or null when the backend has no limit */
  backends: { id: string; tier: string; model: string; location: string; enabled: boolean; contextWindow: number | null }[];
  intents: string[];
  keyScopes: string[];
  keyExpiryDays: number[];
  maxActiveKeys: number;
  limits: ConsoleLimits;
  support: SupportSettings;
}

/** how the support assistant answers, so the playground describes it with the real numbers */
export interface SupportSettings {
  /** knowledge-base entries given to the model */
  contextK: number;
  /** confidence = vote × retrieval vote + coverage × coverage + model × the model's own confidence */
  confidenceWeights: { vote: number; coverage: number; model: number };
}

/** the request limits the API enforces, so the playground can check before sending */
export interface ConsoleLimits {
  supportMessageChars: number;
  chatMessageChars: number;
  chatTotalChars: number;
  chatMaxMessages: number;
  maxCompletionTokens: number;
  chatDefaultCompletionTokens: number;
  supportAnswerTokens: number;
  supportReasoningExtraTokens: number;
}

export interface DemoAccount {
  email: string;
  role: Role;
  tenant: string;
  password: string | null;
}

export interface BackendStatus {
  id: string;
  tier: string;
  model: string;
  enabled: boolean;
  location: string;
  health?: { label: "online" | "offline"; availability: string; reason?: string; checkedAt: number | null; probeLatencyMs?: number | null };
  breaker: { state: string; reopensInMs?: number; lastError?: string | null; consecutiveFailures?: number };
  chaos?: { failRate: number; mode: string; addedLatencyMs: number };
  /** operators only: prices (USD per 1M tokens) and timeouts */
  priceInPerM?: number;
  priceOutPerM?: number;
  firstTokenTimeoutMs?: number;
  totalTimeoutMs?: number;
  contextWindow?: number | null;
}

/** one metered request, with the gateway's column names */
export interface RequestRow {
  id: string;
  tenant_id: string;
  endpoint: string;
  created_at: number;
  outcome: string;
  /** an API key id, or user:<id> for a console playground run */
  credential: string | null;
  credential_name?: string | null;
  /** PII types and counts, e.g. "email:1,card:1"; never values */
  pii: string | null;
  /** "backend:outcome,…" in attempt order */
  attempt_trail?: string | null;
  intent: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  usage_source: string;
  latency_ms: number | null;
  ttft_ms: number | null;
  cost_usd: number;
  fallback_used: number;
  error_code: string | null;
  error_message: string | null;
  route_reason: { rule: string; reason: string; chain: string[]; signals: unknown } | null;
}

export interface AttemptRow {
  id: number;
  seq: number;
  backend: string;
  outcome: string;
  error: string | null;
  latency_ms: number | null;
  ttft_ms: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  usage_source: string;
  cost_usd: number;
}

/** a metered request with every attempt, for the Logs drawer */
export interface RequestDetail extends RequestRow {
  attempts: AttemptRow[];
}

export interface ApiKey {
  id: string;
  tenantId: string;
  name: string;
  prefix: string;
  last4: string;
  scopes: string[];
  createdBy: string | null;
  createdByEmail: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  status: "active" | "expired" | "revoked";
}

/** outcome groups every chart and badge uses */
export type Group = "success" | "refused" | "rejected" | "failed";

export type Range = "1h" | "24h" | "7d" | "30d";

export interface ParetoRow {
  label: string;
  count: number;
  share: number;
  cumulative: number;
}

export interface GroupTotals {
  requests: number;
  tokens: number;
  costUsd: number;
}
export interface Bucket {
  t: number;
  requests: number;
  outcomes: Record<Group, number>;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  modelCalls: number;
  fallbacks: number;
  fallbackRate: number | null;
  p50: number | null;
  p95: number | null;
  byBackend: Record<string, GroupTotals>;
  byTenant: Record<string, GroupTotals>;
}
export interface Metrics {
  range: Range;
  bucketMs: number;
  totals: {
    requests: number;
    successRate: number | null;
    tokens: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    modelCalls: number;
    fallbackRate: number | null;
    p50: number | null;
    p95: number | null;
    outcomes: Record<Group, number>;
    piiRequests: number;
    piiByType: Record<string, number>;
  };
  buckets: Bucket[];
  byTenant: { tenant: string; requests: number; tokens: number; costUsd: number }[];
  byBackend: { backend: string; requests: number; share: number }[];
  paretoIntents: ParetoRow[];
  paretoIssues: ParetoRow[];
}

export interface TenantUsage {
  tenant: string;
  name: string;
  plan: string;
  allowedTiers: string[];
  profileFields: number;
  periodStart: number;
  periodEnd: number;
  tokensUsed: number;
  tokensReserved: number;
  requestsUsed: number;
  tokenQuota: number;
  requestQuota: number;
  tokensRemaining: number;
  requestsRemaining: number;
  costUsd: number;
  /** 429 quota_exceeded responses this period */
  quotaRejections: number;
  /** the newest request this period was refused for quota: new requests are being turned away */
  rejecting: boolean;
  outcomes: { outcome: string; n: number }[];
}

export interface Member {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  lastLoginAt: number | null;
  disabled: boolean;
}

export interface AuditEntry {
  id: number;
  at: number;
  tenantId: string | null;
  actorEmail: string | null;
  action: string;
  target: string | null;
  meta: Record<string, unknown>;
}

export interface PiiTestResult {
  masked: string;
  findings: { type: string; label: string; placeholder: string }[];
}

export interface Governance {
  tenant: { id: string; name: string };
  piiPolicy: { mode: PiiMode; types: string[] };
  piiTypes: { id: string; label: string }[];
  stats: { windowDays: number; requests: number; requestsWithPii: number; blocked: number; byType: Record<string, number> };
  canEdit: boolean;
}

export interface EvalSummary {
  config: string;
  intentAccuracy: number;
  falseRefusals: number;
  oodCorrectlyRefused: number;
  oodTotal: number;
  rougeLMean: number | null;
  judgeMean: number | null;
  judgeN: number;
  latencyP50: number | null;
  latencyP95: number | null;
  ttftP50: number | null;
  tokensPerModelCall: number;
  costPer1kRequestsUsd: number;
  fallbacks: number;
  errors: number;
  answersWithRawPlaceholders?: number;
  backends: Record<string, number>;
}
export interface EvalRun {
  file: string;
  stamp: string;
  judge: string | null;
  n: { inDomain: number; ood: number };
  configs: EvalSummary[];
}

export type PlaygroundEndpoint = "support" | "chat";
export const ENDPOINT_PATH: Record<PlaygroundEndpoint, string> = { support: "/v1/support/answer", chat: "/v1/chat/completions" };

export type PlaygroundBody =
  | { message: string; model?: string; prompt_version?: string; include_reasoning?: boolean; tenant?: string }
  | { messages: { role: "system" | "user" | "assistant"; content: string }[]; model?: string; include_reasoning?: boolean; tenant?: string };
