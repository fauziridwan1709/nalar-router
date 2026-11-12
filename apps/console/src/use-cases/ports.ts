/**
 * The one port the console needs: the gateway's console API, as typed operations. Pages and
 * hooks depend on this interface, never on fetch or URLs; interface-adapters/gateways/http/consoleApi.ts
 * implements it over HTTP, and tests can pass a fake.
 */
import type {
  ApiKey, AuditEntry, BackendStatus, ConsoleConfig, DemoAccount, EvalRun, Governance, Member, Metrics,
  PiiTestResult, PlaygroundBody, PlaygroundEndpoint, Range, SessionUser, TenantUsage,
} from "../entities/models";
import { ApiError } from "../entities/errors";

/** one request row in the Logs table, and its detail with attempts (shapes owned by the gateway) */
export type RequestRow = Record<string, any>;
export type RequestDetail = Record<string, any>;

export interface PlaygroundHandlers {
  /** each event in the support stream's vocabulary: meta, route, retrieval, attempt, token, reasoning, refusal, error, done */
  onEvent: (event: string, data: any) => void;
  /** the response body as an API client receives it, growing while it streams */
  onRaw: (raw: string) => void;
}

export interface ConsoleApi {
  auth: {
    signIn(email: string, password: string): Promise<SessionUser>;
    /** the signed-in user, or null when there is no session */
    session(): Promise<SessionUser | null>;
    signOut(): Promise<void>;
    demoAccounts(): Promise<DemoAccount[]>;
    /** called when any request finds the session gone */
    onSignedOut(handler: () => void): void;
  };
  config(): Promise<ConsoleConfig>;
  metrics(q: { range: Range; tenant?: string; backend?: string }): Promise<Metrics>;
  usage(tenant?: string): Promise<TenantUsage[]>;
  resetQuota(tenantId: string): Promise<void>;
  backends(): Promise<BackendStatus[]>;
  setChaos(backendId: string, patch: Record<string, unknown>): Promise<void>;
  clearChaos(): Promise<void>;
  requests(q: { limit: number; tenant?: string }): Promise<RequestRow[]>;
  request(id: string): Promise<RequestDetail>;
  keys(tenant?: string): Promise<ApiKey[]>;
  createKey(tenant: string | undefined, body: { name: string; scopes: string[]; expiresInDays: number | null }): Promise<{ key: ApiKey; secret: string }>;
  revokeKey(id: string, tenant?: string): Promise<void>;
  audit(tenant?: string): Promise<AuditEntry[]>;
  members(tenant?: string): Promise<Member[]>;
  governance(tenant?: string): Promise<Governance>;
  setPiiPolicy(tenant: string | undefined, policy: Governance["piiPolicy"]): Promise<void>;
  testPii(tenant: string | undefined, text: string): Promise<PiiTestResult>;
  evals(): Promise<EvalRun[]>;
  /** one playground run, streamed or not; throws ApiError when the gateway refuses it */
  playground(endpoint: PlaygroundEndpoint, body: PlaygroundBody, stream: boolean, handlers: PlaygroundHandlers, signal?: AbortSignal): Promise<{ status: number }>;
}
