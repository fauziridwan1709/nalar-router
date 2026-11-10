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
