/**
 * Every error the gateway can return, in one catalog. GatewayError only accepts a code from it,
 * so a new error can't ship without a status, a retry rule and a line in docs/ERRORS.md
 * (tests/errors.test.ts checks both).
 *
 * Wire shape: `{ "error": { "code", "message", "details"? } }`. On the OpenAI-compatible routes
 * the body also carries OpenAI's `type` and `param`.
 *
 * Messages carry the least detail that still helps the caller: the same 401 for an unknown,
 * revoked or expired key; 403 doesn't name the permission; upstream provider text and stack
 * traces stay in the database and the server log, never in a response.
 */
export interface ErrorInfo {
  /** HTTP status (499 is nginx's "client closed request", used only in metering) */
  status: number;
  /** may the same request succeed if retried unchanged, after `Retry-After` if present? */
  retryable: boolean;
  /** when it happens, for docs/ERRORS.md */
  when: string;
}

export const ERROR_CATALOG = {
  // ---- request errors, before admission (metered as rejected, never counted against quota)
  invalid_json: { status: 400, retryable: false, when: "The body is not valid JSON." },
  invalid_request: { status: 400, retryable: false, when: "The body fails validation; the message names each field." },
  unknown_model: { status: 400, retryable: false, when: "`model` is not `auto`, a tier or a backend id; `details.available` lists them." },
  missing_api_key: { status: 401, retryable: false, when: "No `Authorization: Bearer` key (or `x-api-key`) on a /v1 route." },
  invalid_api_key: { status: 401, retryable: false, when: "The key is unknown, revoked or expired (deliberately indistinguishable)." },
  invalid_admin_token: { status: 401, retryable: false, when: "An /admin route without the right `x-admin-token`." },
  unauthenticated: { status: 401, retryable: false, when: "A console route without a valid session." },
  invalid_credentials: { status: 401, retryable: false, when: "Wrong email or password (the same reply for an unknown account)." },
  insufficient_scope: { status: 403, retryable: false, when: "The key is valid but lacks the scope this route needs." },
  model_not_allowed: { status: 403, retryable: false, when: "The pinned model or tier is outside the tenant's plan." },
  forbidden: { status: 403, retryable: false, when: "The signed-in role lacks the permission (it isn't named)." },
  csrf_failed: { status: 403, retryable: false, when: "A console write without the session's CSRF token, or from another origin." },
  not_found: { status: 404, retryable: false, when: "Unknown route, or an object that doesn't exist or belongs to another tenant (same reply)." },
  key_limit_reached: { status: 409, retryable: false, when: "Creating an API key past the per-tenant limit of active keys." },
  payload_too_large: { status: 413, retryable: false, when: "The body exceeds 64 kB." },
  pii_detected: { status: 422, retryable: false, when: "The tenant's PII policy is `block` and the message contains personal data; `details.types` lists the kinds." },
  quota_exceeded: { status: 429, retryable: true, when: "The monthly request or token quota can't cover this request. `Retry-After` points at the next period; `details` has what's left." },
  too_many_attempts: { status: 429, retryable: true, when: "Too many failed sign-ins for the account or IP. `Retry-After` says when to try again." },
  internal_error: { status: 500, retryable: true, when: "An unexpected failure; logged with the request id, never described in the response." },
  quota_unavailable: { status: 503, retryable: true, when: "The quota check itself failed (database error). Fails closed: no model is called." },
  no_backend_available: { status: 503, retryable: true, when: "No enabled backend is in the tenant's plan." },
  // ---- run errors, after admission: the request is metered and the code arrives as an `error` event (stream) or in the body
  all_backends_failed: { status: 502, retryable: true, when: "Every backend in the route chain failed before the first token; each attempt is in `attempts`." },
  stream_interrupted: { status: 502, retryable: true, when: "The model failed after the first token was sent. No fallback (two models' text is never spliced); outcome `partial`." },
  client_aborted: { status: 499, retryable: false, when: "The client disconnected; the provider call is cancelled and what was used is metered." },
} as const satisfies Record<string, ErrorInfo>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

/** Errors that map 1:1 to an HTTP status and a stable machine-readable code. */
export class GatewayError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
  get retryable() {
    return ERROR_CATALOG[this.code].retryable;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

/**
 * Raised by backends and the executor. `retryable` means another backend may succeed, so the
 * executor falls back; it never does once the first token has been sent.
 *
 * - error, http            the provider failed or returned a non-2xx status
 * - timeout_first_token    no token (or reasoning) within the backend's first-token timeout
 * - timeout_total          the whole call ran past the backend's total timeout
 * - unusable_output        the output failed validation (bad support header, empty answer)
 * - aborted                the client went away; not retryable
 * - escalated              auto-cascade: the fast model's header was unsure, so move up to the strong tier
 */
export class BackendError extends Error {
  constructor(
    public kind: "error" | "timeout_first_token" | "timeout_total" | "unusable_output" | "aborted" | "http" | "escalated",
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
  escalated: "escalated to the strong tier",
  classified: "routing classification",
};
export const publicAttemptError = (outcome: string) => PUBLIC_ATTEMPT_ERROR[outcome] ?? "attempt failed";
