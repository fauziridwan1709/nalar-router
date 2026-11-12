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
}
export interface ConsoleConfig {
  tenants: ConsoleTenant[];
  /** contextWindow: max tokens in + out per call, or null when the backend has no limit */
  backends: { id: string; tier: string; model: string; location: string; enabled: boolean; contextWindow: number | null }[];
  intents: string[];
  keyScopes: string[];
  keyExpiryDays: number[];
  maxActiveKeys: number;
  limits: ConsoleLimits;
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
  [k: string]: any;
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
  piiPolicy: { mode: "mask" | "block" | "off"; types: string[] };
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
