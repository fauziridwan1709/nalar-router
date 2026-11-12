/**
 * Persistence ports the use cases need. interface-adapters/gateways/sqlite implements them; tests can
 * use the same SQLite adapter in memory. Swapping in Postgres means a new adapter, not new use cases.
 */
import type { Tenant } from "../../entities/types.js";
import type { Usage } from "../../entities/quota.js";
import type { AttemptRecord, FinalRecord, MeterSummary } from "../../entities/metering.js";

export interface AdmitInput {
  requestId: string;
  endpoint: string;
  estimatedPromptTokens: number;
  requestedMaxTokens: number;
  promptVersion?: string | null;
  /** which credential made the call: an api key id, or user:<id> for the console playground */
  credential?: string | null;
}

export interface Admission {
  maxCompletionTokens: number;
  usage: Usage;
}

export interface QuotaStore {
  /**
   * Atomically checks the quota and records the request with a token reservation.
   * Throws GatewayError 429 `quota_exceeded`, or 503 `quota_unavailable` on any storage error
   * (fail closed: no model is called).
   */
  admit(tenant: Tenant, input: AdmitInput): Admission;
  usage(tenant: Tenant): Usage;
  /** start a new quota period now */
  reset(tenantId: string): void;
}

export interface MeteringStore {
  /** final row + attempts + release of the reservation, in one transaction */
  finish(requestId: string, record: FinalRecord, attempts: AttemptRecord[]): MeterSummary;
  /** a request refused before admission (validation, PII block): metered, not counted against quota */
  rejected(
    requestId: string,
    tenantId: string,
    endpoint: string,
    status: number,
    code: string,
    message: string,
    credential: string,
  ): void;
  /** PII types and counts for a request (never values) */
  pii(requestId: string, summary: string): void;
}
