# API reference

Every endpoint is served by `apps/gateway`. Tenant endpoints take `Authorization: Bearer <tenant key>` (or `x-api-key`). Admin endpoints take `x-admin-token`.

## `POST /v1/support/answer` (the capability)

```bash
curl -N http://localhost:3000/v1/support/answer \
  -H 'authorization: Bearer sk-acme-demo-7f3a9c' -H 'content-type: application/json' \
  -d '{"message":"how do I cancel order 123?"}'
```

Body:
- `message`: 1–2000 chars
- `model`: optional; `auto`, a tier, or a backend id
- `prompt_version`: `v1`, `v2` or `v3` (default `v3`)
- `placeholders`: `fill` (default) or `raw`. With `fill`, template slots such as `{{Order Number}}` are filled in before streaming, from the customer's message, the tenant's company profile, default UI labels, or a natural phrase. With `raw`, the model's text is streamed untouched.
- `stream`: defaults to `true`
- `include_reasoning`: defaults to `false`. When `true`, the model's thinking is streamed as `reasoning` events. On Groq gpt-oss this costs nothing extra, since the model reasons anyway. On the local Qwen model it turns thinking on, which is much slower.

The response is a stream of Server-Sent Events, in this order:

| event | payload |
|---|---|
| `meta` | `requestId`, tenant |
| `route` | `rule`, `reason`, `chain`, `signals` (why this backend was picked) |
| `retrieval` | `coverage`, intent `votes`, top `entries` (id, intent, score, question, answer) |
| `attempt` | one per backend try: `started`, then `ok` / `error` / `timeout_first_token` / `timeout_total` / `unusable_output` / `skipped_circuit_open` / `refused`, with latency, tokens and cost |
| `intent` | `intent`, `confidence` (0–1), `label`, `components`, `agreesWithRetrieval`. Sent right before the first token. |
| `step` | intermediate decisions: `scope_gate` (passed or refused, with the reason), `header_validated` (the model's intent and self-reported confidence), and `placeholders_rendered` (each slot filled, with its value and source: `message`, `profile`, `ui_label` or `fallback`) |
| `reasoning` | `{seq, backend, text}`: model thinking, only sent when `include_reasoning` is set. It is diagnostic only: never parsed, never part of the answer, and it can come from an attempt that is later discarded by fallback. |
| `token` | `{text}`, the streamed answer |
| `refusal` | `reason` (`out_of_scope` / `low_confidence`) and the message shown to the customer |
| `error` | `code` (`all_backends_failed`, `stream_interrupted`, …), `partial` |
| `done` | `requestId`, `outcome`, `backend`, `model`, `fallbackUsed`, `usage{prompt,completion,total,source}`, `costUsd`, `latencyMs`, `ttftMs`, `intent`, `confidence`, remaining `quota` |

Every event except `token` and `reasoning` includes `t`, the milliseconds since the gateway received the request. The console uses it to draw the trace. The `meta` event also reports the quota admission: `maxCompletionTokens` and the tokens and requests remaining.

With `"stream": false` you get the same information as one JSON object, including `steps` and, if requested, `reasoning`.

## `POST /v1/chat/completions` (raw gateway, OpenAI-compatible)

```bash
curl -N http://localhost:3000/v1/chat/completions -H 'authorization: Bearer sk-acme-demo-7f3a9c' \
  -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"hi"}],"model":"auto"}'
```

It streams standard `chat.completion.chunk`s. The final chunk carries `usage` and an `x_router` block with backend, fallback, cost and trace.

## `GET /v1/backends`

This lists every backend, including ones not configured on this host. For each it returns the online/offline label, where the model runs, and whether the caller's plan may use it.

```json
[{ "id": "local-qwen", "tier": "local", "location": "local", "allowedForTenant": true,
   "health": { "label": "offline", "availability": "disabled",
               "reason": "runs on a local machine; not configured on this deployment" },
   "breaker": "closed" }]
```

`availability` is one of:
- `online` or `offline`: the result of probing `GET {baseUrl}/models` every 30 s
- `disabled`: the backend isn't configured on this host
- `unknown`: not probed yet

The probe only feeds the label. Routing relies on the circuit breaker and fallback.

## `GET /admin/metrics?range=15m|1h|24h|7d&tenant=`

Dashboard aggregates come from the same `requests` table that meters billing and enforces quota, so the charts always agree with both. The response includes:
- `totals`: requests, success rate, tokens, cost, model calls, fallback rate, p50 and p95 latency, and outcome groups
- `buckets[]`: the same figures per time bucket. Buckets are aligned to the wall clock: 1 min for `15m`, 5 min for `1h`, 1 h for `24h`, 6 h for `7d`.
- `byTenant[]` and `byBackend[]` breakdowns

Outcome groups:

| group | outcomes |
|---|---|
| `success` | success |
| `refused` | `refused_*` |
| `rejected` | quota exceeded, invalid input |
| `failed` | all backends failed, partial, internal error, aborted |

Latency and fallback rate only count requests that reached a model.

## `GET /admin/evals`

Returns a summary of each committed eval run in `tools/eval/results/*.json`. Per-case rows are left out.

## Other endpoints

- `GET /v1/usage` returns the calling tenant's usage and remaining quota.
- `GET /v1/requests/:id` returns one of the tenant's own requests, with its attempts.
- These require `x-admin-token`:
  - `GET /admin/usage`
  - `GET /admin/requests?tenant=&limit=`
  - `GET /admin/requests/:id`, which returns the routing decision and every attempt
  - `GET /admin/backends`, which returns health, breaker state and chaos settings
  - `PUT /admin/chaos/:backend`, with body `{failRate, mode: error|hang|garbage|slow_first_token, addedLatencyMs}`
  - `DELETE /admin/chaos`
  - `POST /admin/tenants/:id/reset-quota`
- `GET /healthz`

## Console API (session auth)

The console signs in with email and password and then uses a session cookie. Keys and the admin token never reach the browser.

- `POST /api/auth/login` with `{email, password}` (strict). Returns `{user, csrfToken}` and sets the `HttpOnly`, `SameSite=Strict` session cookie. Errors: `400 invalid_request` (one generic message for any bad input), `401 invalid_credentials` (same for a wrong password and an unknown account), `429 too_many_attempts` with `Retry-After`, `403 csrf_failed` for a cross-origin request.
- `GET /api/auth/session` returns `{user, csrfToken}` or `401 unauthenticated`. `POST /api/auth/logout` ends the session.
- `GET /api/auth/demo-accounts` lists the demo accounts, only when `DEMO_MODE=true`.
- Every `POST`, `PUT` and `DELETE` below needs the `x-csrf-token` header.
- Non-operators are always scoped to their own tenant; operators may pass `?tenant=`. Another tenant's object returns `404`.

| endpoint | permission |
|---|---|
| `GET /api/console/config` | signed in |
| `GET /api/console/metrics?range=&tenant=` | `dashboard:read` (also returns `paretoIssues` and `paretoIntents`) |
| `GET /api/console/requests?limit=&tenant=`, `GET /api/console/requests/:id` | `requests:read` |
| `GET /api/console/usage?tenant=` | `usage:read` |
| `GET /api/console/backends` | `backends:read` (probe details, breaker errors and chaos only for operators) |
| `GET /api/console/evals` | `evals:read` |
| `GET /api/console/keys?tenant=` | `keys:read` |
| `POST /api/console/keys` with `{name, scopes[], expiresInDays: 7\|30\|90\|365\|null}` | `keys:create`. `201 {key, secret}`; the only response that carries the secret. `409 key_limit_reached` past 10 active keys. |
| `DELETE /api/console/keys/:id` | `keys:revoke_any`, or `keys:revoke_own` for keys you created |
| `GET /api/console/audit?tenant=` | `audit:read` |
| `POST /api/console/tenants/:id/reset-quota` | `quota:reset` |
| `PUT /api/console/chaos/:backend`, `DELETE /api/console/chaos` | `chaos:write` |
| `POST /api/console/playground/support` | `playground:run`. Same body as `/v1/support/answer`, plus `tenant` for operators. |

## Errors

Every error has the shape `{"error": {"code", "message", "details?"}}`.

| status | code | when |
|---|---|---|
| 400 | `invalid_request` / `invalid_json` / `unknown_model` | bad input, with the field-level reason |
| 401 | `missing_api_key` / `invalid_api_key` | unknown, revoked and expired keys all get `invalid_api_key` |
| 401 | `unauthenticated` / `invalid_credentials` | console: no session / sign-in failed |
| 403 | `insufficient_scope` | the key lacks the endpoint's scope |
| 403 | `forbidden` / `csrf_failed` | console: the role lacks the permission / missing CSRF token or cross-origin |
| 403 | `model_not_allowed` | the tenant asked for a tier its plan doesn't include |
| 413 | `payload_too_large` | body over 64 kB |
| 429 | `quota_exceeded` | includes the remaining quota, `resetsAt` and `Retry-After` |
| 429 | `too_many_attempts` | console sign-in paused after repeated failures; `Retry-After` |
| 409 | `key_limit_reached` | the tenant already has 10 active keys |
| 502 | `all_backends_failed` | every backend errored, timed out or returned unusable output |
| 503 | `quota_unavailable` | the quota check itself failed, so the request is rejected (fail closed) |
