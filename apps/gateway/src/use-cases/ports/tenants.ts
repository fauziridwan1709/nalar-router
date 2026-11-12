/** Tenant records: the console reads them and an owner or operator changes the PII policy. */
import type { PiiPolicy } from "../../entities/guardrails/pii.js";
import type { Tenant } from "../../entities/types.js";

export interface TenantRepository {
  get(id: string): Tenant | null;
  list(): Tenant[];
  setPiiPolicy(id: string, policy: PiiPolicy): void;
}
