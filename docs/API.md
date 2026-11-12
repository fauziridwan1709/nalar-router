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
- `model`: optional; a router mode (`auto`, `auto-smart`, `auto-cascade`), a tier, or a backend id. `auto` routes on the complexity heuristic; `auto-smart` asks a small model to classify the message first (one extra metered call, ~0.5 s); `auto-cascade` starts on fast and moves to strong before streaming if the fast model's header is unsure. See REPORT §3.
- `prompt_version`: `v1`, `v2` or `v3` (default `v3`)
- `placeholders`: `fill` (default) or `raw`. With `fill`, template slots such as `{{Order Number}}` are filled in before streaming, from the customer's message, the tenant's company profile, default UI labels, or a natural phrase. With `raw`, the model's text is streamed untouched.
- `stream`: defaults to `true`
- `include_reasoning`: defaults to `false`. When `true`, the model's thinking is streamed as `reasoning` events. On Groq gpt-oss this costs nothing extra, since the model reasons anyway. On the local Qwen model it turns thinking on, which is much slower.

The response is a stream of Server-Sent Events, in this order:

| event | payload |
|---|---|
| `meta` | `requestId`, tenant |
| `route` | `rule`, `reason`, `chain`, `signals` (why this backend was picked). On auto routing `signals.complexity` is `{score, level, threshold, signals: [{id, weight, detail}]}`; see REPORT §3 |
| `retrieval` | `coverage`, intent `votes`, top `entries` (id, intent, score, question, answer) |
| `attempt` | one per backend try: `started`, then `ok` / `error` / `timeout_first_token` / `timeout_total` / `unusable_output` / `skipped_circuit_open` / `aborted` / `refused` / `escalated` (auto-cascade) / `classified` (auto-smart, attempt 0), with latency, tokens and cost |
| `intent` | `intent`, `confidence` (0–1), `label`, `components`, `agreesWithRetrieval`. Sent right before the first token. |
| `step` | intermediate decisions: `pii_guard` (the types masked, never the values), `route_classified` (the auto-smart verdict), `cascade_escalated` (why the fast attempt was dropped), `scope_gate` (passed or refused, with the reason), `header_validated` (the model's intent and self-reported confidence), and `placeholders_rendered` (each slot filled, with its value and source: `message`, `profile`, `ui_label` or `fallback`) |
| `reasoning` | `{seq, backend, text}`: model thinking, only sent when `include_reasoning` is set. It is diagnostic only: never parsed, never part of the answer, and it can come from an attempt that is later discarded by fallback. |
| `token` | `{text}`, the streamed answer |
| `refusal` | `reason` (`out_of_scope` / `low_confidence`) and the message shown to the customer |
| `error` | `code` (`all_backends_failed`, `stream_interrupted`, …), `partial` |
| `done` | `requestId`, `outcome`, `backend`, `model`, `fallbackUsed`, `usage{prompt,completion,total,source}`, `costUsd`, `latencyMs`, `ttftMs`, `intent`, `confidence`, remaining `quota` |

Every event except `token` and `reasoning` includes `t`, the milliseconds since the gateway received the request. The console uses it to draw the trace. The `meta` event also reports the quota admission: `maxCompletionTokens` and the tokens and requests remaining.

With `"stream": false` you get the same information as one JSON object, including `steps` and, if requested, `reasoning`.

## `POST /v1/chat/completions` (raw gateway, OpenAI-compatible)

It follows OpenAI's Chat Completions contract, so the official OpenAI SDKs work by changing the base URL. It is checked against `openai` (Node) for: default JSON, `stream: true`, `stream_options.include_usage`, `max_completion_tokens`, text content parts, the `developer` role, sampling parameters, `models.list()` and a bad key raising `AuthenticationError`.

```bash
curl http://localhost:3000/v1/chat/completions -H 'authorization: Bearer sk-acme-demo-7f3a9c' \
  -H 'content-type: application/json' -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'
```

- **`stream` defaults to `false`**, as in OpenAI: one `chat.completion` object. With `"stream": true` it sends `chat.completion.chunk`s and ends with `data: [DONE]`.
- **Request fields:** `model` (`auto`, `auto-smart`, or `auto-cascade`, which chat routes like `auto` because it has no header to judge; a tier such as `fast`, or a backend id; see `GET /v1/models`), `messages`, `stream`, `stream_options.include_usage`, `max_completion_tokens` (or the older `max_tokens`), `temperature`, `top_p`, `stop`, `seed`, `presence_penalty`, `frequency_penalty`, `n` (only 1) and `user` (accepted, not stored). Message `content` may be a string or an array of `text` parts; `developer` is treated as `system`.
- **Not supported, rejected with a 400 that names the field:** tools and function calling, `response_format`, `logprobs`, and image or audio parts.
- **Extensions:** an `x_router` block on the response (or on the final chunk) with backend, fallback, cost, route and attempts; `include_reasoning` to receive the model's reasoning (`delta.reasoning` while streaming); routing and attempt events as SSE comments (`: route {…}`, `: attempt {…}`, each with `t`, ms since the request started), which OpenAI clients ignore. The final content chunk also carries `usage`; with `stream_options.include_usage` a separate usage-only chunk (`choices: []`) follows, as OpenAI sends it.
- **Errors** have OpenAI's shape: `{error: {message, type, param, code}}`, with `type` one of `invalid_request_error`, `authentication_error`, `permission_error`, `not_found_error`, `rate_limit_error`, `api_error`.
- `id` is the gateway's request id (`req_…`) and `model` is the model that actually answered (for example `openai/gpt-oss-20b`), not the alias you sent.

This is OpenAI's format, not Anthropic's. Claude's Messages API (`POST /v1/messages`) returns `content` blocks, `stop_reason` and `usage.input_tokens`/`output_tokens`, and streams typed events (`message_start`, `content_block_delta`…). Claude models serve OpenAI-format clients only through Anthropic's separate OpenAI SDK compatibility layer.

## `GET /v1/models`

OpenAI's model list for the key's plan: `{object: "list", data: [{id, object: "model", created, owned_by}]}`. The ids are the router modes `auto`, `auto-smart` and `auto-cascade`, then the tiers, then the backends the plan may use. It needs the `chat.completions` scope.

```bash
curl http://localhost:3000/v1/models -H 'authorization: Bearer sk-acme-demo-7f3a9c'
```

## `GET /v1/backends`

This lists every backend, including ones not configured on this host. For each it returns the online/offline label, where the model runs, and whether the caller's plan may use it.

```json
[{ "id": "local-qwen3.5-4b", "tier": "local", "location": "local", "allowedForTenant": true,
   "health": { "label": "offline", "availability": "disabled",
               "reason": "runs on a local machine; not configured on this deployment" },
   "breaker": "closed" }]
```

`availability` is one of:
- `online` or `offline`: the result of probing `GET {baseUrl}/models` every 30 s
- `disabled`: the backend isn't configured on this host
- `unknown`: not probed yet

The probe only feeds the label. Routing relies on the circuit breaker and fallback.

## `GET /admin/metrics?range=15m|1h|24h|7d|30d&tenant=`

Dashboard aggregates come from the same `requests` table that meters billing and enforces quota, so the charts always agree with both. The response includes:
- `totals`: requests, success rate, tokens, cost, model calls, fallback rate, p50 and p95 latency, and outcome groups
- `buckets[]`: the same figures per time bucket. Buckets are aligned to the wall clock: 1 min for `15m`, 5 min for `1h`, 1 h for `24h`, 6 h for `7d`, 1 day for `30d`.
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
| `POST /api/console/playground/chat` | `playground:run`. Same body as `/v1/chat/completions` (incl. `stream`), plus `tenant` for operators. Metered as `chat.completions`. |
| `GET /api/console/governance?tenant=` | `governance:read`. The PII policy, the types it can detect, 30-day stats (requests, with PII, blocked, by type) and `canEdit`. |
| `PUT /api/console/governance/pii` with `{mode: mask\|block\|off, types: [email, phone, card, national_id, iban, ip_address]}` | `governance:write`. Audited as `governance.pii_policy`. |
| `POST /api/console/governance/pii/test` with `{text}` (≤ 2,000 chars) | `governance:read`. Returns the masked text and findings; nothing is stored or sent to a model. |
| `GET /api/console/members?tenant=` | `members:read` (owners, operators) |
| `GET /api/console/metrics` also accepts `backend=` and `range=30d` | buckets carry `byBackend` and `byTenant` (requests, tokens, cost) and totals carry `promptTokens`, `completionTokens`, `piiRequests` and `piiByType` |

## PII guardrail

Every request on `/v1/support/answer`, `/v1/chat/completions` and the console playground is scanned with the tenant's policy before retrieval, routing or a model call.

- `mask`: values are replaced with `{{Customer Email}}`, `{{Customer Phone}}`, `{{Card Number}}`, `{{National ID}}`, `{{Bank Account}}` or `{{IP Address}}`, numbered from the second (`{{Customer Email 2}}`). The support answer restores email and phone, and shows card, ID and bank numbers only as "ending in 1234". The chat endpoint leaves the placeholders as they are.
- `block`: `422 pii_detected` with `details.types`, before admission; no model call, no quota.
- The SSE stream carries a `step` event `{name: "pii_guard", mode, masked: [{type, label, placeholder}]}`, with types only, never values. The request row stores `pii` as `type:count` pairs.

## Errors

Every error has the shape `{"error": {"code", "message", "details?"}}`. The full list (every code, its status, whether a retry can help, and when it happens), along with how errors appear mid-stream, is in **[ERRORS.md](ERRORS.md)**. It is checked against the source on every test run.
