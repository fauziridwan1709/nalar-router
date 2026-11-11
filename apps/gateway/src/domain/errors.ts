/** Errors that map 1:1 to an HTTP status and a stable machine-readable code. */
export class GatewayError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

/** Raised by backends. `retryable` = another backend may succeed. */
export class BackendError extends Error {
  constructor(
    public kind: "error" | "timeout_first_token" | "timeout_total" | "unusable_output" | "aborted" | "http",
    message: string,
    public retryable = true,
    public httpStatus?: number,
  ) {
    super(message);
  }
}

/**
 * What a tenant is told about a failed attempt. The full message (upstream HTTP bodies,
 * fragments of model output) stays in the attempts table for operators; it never goes over
 * the wire, because it can carry provider internals.
 */
const PUBLIC_ATTEMPT_ERROR: Record<string, string> = {
  error: "upstream model error",
  http: "upstream model error",
  timeout_first_token: "no first token in time",
  timeout_total: "model call timed out",
  unusable_output: "model output failed validation",
  aborted: "cancelled",
  skipped_circuit_open: "circuit breaker open",
};
export const publicAttemptError = (outcome: string) => PUBLIC_ATTEMPT_ERROR[outcome] ?? "attempt failed";
