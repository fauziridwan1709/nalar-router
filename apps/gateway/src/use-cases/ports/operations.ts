/** Operator controls and status: fault injection, backend health probes, committed eval runs. */
export type ChaosMode = "error" | "hang" | "garbage" | "slow_first_token";

export interface ChaosSettings {
  /** probability [0..1] that a call is affected */
  failRate: number;
  mode: ChaosMode;
  /** added before the first byte on every call */
  addedLatencyMs: number;
}

export interface FaultInjection {
  get(backendId: string): ChaosSettings;
  set(backendId: string, s: Partial<ChaosSettings>): ChaosSettings;
  clear(): void;
}

export type Availability = "online" | "offline" | "disabled" | "unknown";

export interface BackendHealth {
  id: string;
  location: string;
  availability: Availability;
  label: "online" | "offline";
  reason: string;
  checkedAt: number | null;
  probeLatencyMs: number | null;
}

export interface HealthReader {
  get(backendId: string): BackendHealth | undefined;
}

export interface EvalRunSummary {
  file: string;
  stamp: unknown;
  judge: unknown;
  n: unknown;
  configs: unknown[];
}

export interface EvalResults {
  /** newest first; summaries only, the per-case rows stay in the files */
  list(): EvalRunSummary[];
}
