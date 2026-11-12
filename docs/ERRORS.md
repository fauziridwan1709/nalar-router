# Errors

Every error the gateway returns is listed here. The source of truth is `ERROR_CATALOG` in [`apps/gateway/src/domain/errors.ts`](../apps/gateway/src/domain/errors.ts). `GatewayError` only accepts a code from the catalog, and `tests/errors.test.ts` fails if a code is missing from this page or is thrown with a status that doesn't match.

## Shape

```json
{ "error": { "code": "quota_exceeded", "message": "Monthly token quota exhausted: 805 tokens left, this request needs at least 1561.", "details": { "tokensRemaining": 805, "requestsRemaining": 2, "resetsAt": "2026-12-01T00:00:00.000Z" } } }
```

- `code` is stable and machine-readable; branch on it, not on `message`.
- `message` is for people. It carries the least detail that still helps: the same 401 for an unknown, revoked or expired key; a 403 doesn't name the missing permission; a 404 doesn't say whether the object exists in another tenant.
- `details` appears only where it helps the caller act (quota left, the models you may use, the PII types found).
- On `/v1/chat/completions` and `/v1/models` the error also carries OpenAI's `type` (`invalid_request_error`, `authentication_error`, `permission_error`, `not_found_error`, `rate_limit_error`, `api_error`) and `param: null`, so the OpenAI SDKs raise their typed errors.
- Every model-calling response has an `x-request-id` header. Server logs and the metering row use the same id, so give it when reporting a problem.

## Request errors

These are returned as the HTTP status, before any model is called. Requests refused this way are metered as `rejected` and never count against quota. A quota refusal is metered as `quota_exceeded`.

| code | status | retry? | when |
|---|---|---|---|
| `invalid_json` | 400 | no | The body is not valid JSON. |
| `invalid_request` | 400 | no | The body fails validation; the message names each field. |
| `unknown_model` | 400 | no | `model` is not a router mode (`auto`, `auto-smart`, `auto-cascade`), a tier or a backend id; `details.available` lists them. |
| `missing_api_key` | 401 | no | No `Authorization: Bearer` key (or `x-api-key`) on a /v1 route. |
| `invalid_api_key` | 401 | no | The key is unknown, revoked or expired (deliberately indistinguishable). |
| `invalid_admin_token` | 401 | no | An /admin route without the right `x-admin-token`. |
| `unauthenticated` | 401 | no | A console route without a valid session. |
| `invalid_credentials` | 401 | no | Wrong email or password (the same reply for an unknown account). |
| `insufficient_scope` | 403 | no | The key is valid but lacks the scope this route needs. |
| `model_not_allowed` | 403 | no | The pinned model or tier is outside the tenant's plan. |
| `forbidden` | 403 | no | The signed-in role lacks the permission (it isn't named). |
| `csrf_failed` | 403 | no | A console write without the session's CSRF token, or from another origin. |
| `not_found` | 404 | no | Unknown route, or an object that doesn't exist or belongs to another tenant (same reply). |
| `key_limit_reached` | 409 | no | Creating an API key past the per-tenant limit of active keys. |
| `payload_too_large` | 413 | no | The body exceeds 64 kB. |
| `pii_detected` | 422 | no | The tenant's PII policy is `block` and the message contains personal data; `details.types` lists the kinds. |
| `quota_exceeded` | 429 | yes | The monthly request or token quota can't cover this request. `Retry-After` points at the next period; `details` has what's left. |
| `too_many_attempts` | 429 | yes | Too many failed sign-ins for the account or IP. `Retry-After` says when to try again. |
| `internal_error` | 500 | yes | An unexpected failure; logged with the request id, never described in the response. |
| `quota_unavailable` | 503 | yes | The quota check itself failed (database error). Fails closed: no model is called. |
| `no_backend_available` | 503 | yes | No enabled backend is in the tenant's plan. |

`429` responses carry `Retry-After`: the start of the next quota period for `quota_exceeded`, the lockout for `too_many_attempts`.

## Run errors

After admission the response has started (a `200` stream) or the run is reported in the JSON body, so these codes arrive as an `error` event in the stream, or as `error` and `outcome` in the JSON body. The request is always metered, including every attempt.

| code | status | retry? | when |
|---|---|---|---|
| `all_backends_failed` | 502 | yes | Every backend in the route chain failed before the first token; each attempt is in `attempts`. |
| `stream_interrupted` | 502 | yes | The model failed after the first token was sent. No fallback (two models' text is never spliced); outcome `partial`. |
| `client_aborted` | 499 | no | The client disconnected; the provider call is cancelled and what was used is metered. |

How they appear:

- **Support stream:** `event: error` with `{code, message, partial}`, then `event: done` with the outcome.
- **Support JSON** (`stream: false`): the HTTP status is 502 (499 becomes 200, because the client has gone); `error` and `attempts` are in the body.
- **Chat stream:** `data: {"error": {...}}`, then a final chunk with `finish_reason: "error"` and `x_router`, then `data: [DONE]`.
- **Chat JSON:** a `chat.completion` body with `error`, and `x_router.attempts` showing which backend failed and why (`no first token in time`, `model output failed validation`…). Provider error text stays in the attempts table, which only operators can read.

## Not errors

- **Refusals** (off-topic, low confidence, the model said `unknown`) are answers: `200`, `refused: true` with a hand-off message, outcome `refused`. They don't trip the circuit breaker or fall back.
- **Fallback** is not an error either. When a backend fails before the first token, the next one in the chain is tried, and the response shows `fallbackUsed: true` with each attempt's outcome.

## Inside the gateway

| layer | what fails | what happens |
|---|---|---|
| Backend adapters | connect error, non-2xx, timeout, garbage output | `BackendError` with a kind (`error`, `http`, `timeout_first_token`, `timeout_total`, `unusable_output`, `aborted`). The executor records the attempt and tries the next backend, but only before the first token |
| Circuit breaker | 3 consecutive infrastructure failures of one backend (errors, timeouts; not bad model output) | the backend is skipped for 30 s (`skipped_circuit_open` attempt) |
| Quota store | any database error during admission | `503 quota_unavailable`: fails closed, no model is called |
| Metering | a write failing after a run | logged with the request id. The client still gets its answer; the run never becomes an error after the fact |
| Use case | an unexpected exception inside a run | outcome `internal_error`, metered, `error` event; the stack trace goes only to the server log |
| HTTP layer | anything else thrown by a route | the central error handler maps it to the shape above; an unknown error becomes `500 internal_error`, logged with the request id, method and path |
| Process | uncaught exception or unhandled promise rejection | logged, the server stops accepting connections, in-flight requests get 10 s, exit 1 (the platform restarts a clean process) |
| Process | the port is taken | a clear `port … is already in use` message, exit 1 |
| Process | SIGTERM / SIGINT (deploys) | the same 10 s drain, exit 0 |
