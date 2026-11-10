# API reference

Every endpoint is served by `apps/gateway`. Tenant endpoints take `Authorization: Bearer <tenant key>` (or `x-api-key`). Admin endpoints take `x-admin-token`.

## `POST /v1/support/answer` (the capability)

```bash
curl -N http://localhost:3000/v1/support/answer \
  -H 'authorization: Bearer sk-acme-demo-7f3a9c' -H 'content-type: application/json' \
  -d '{"message":"how do I cancel order 123?"}'
```

Body: `message` (1–2000 chars), `model` (`auto` | tier | backend id, optional), `prompt_version` (`v1` | `v2`), `stream` (default `true`).

The response is a stream of Server-Sent Events, in this order:

| event | payload |
|---|---|
| `meta` | `requestId`, tenant |
| `route` | `rule`, `reason`, `chain`, `signals` (why this backend was picked) |
| `retrieval` | `coverage`, intent `votes`, top `entries` (id, intent, score, question, answer) |
| `attempt` | one per backend try: `started`, then `ok` / `error` / `timeout_first_token` / `timeout_total` / `unusable_output` / `skipped_circuit_open` / `refused`, with latency, tokens and cost |
| `intent` | `intent`, `confidence` (0–1), `label`, `components`, `agreesWithRetrieval`. Sent right before the first token. |
| `token` | `{text}`, the streamed answer |
| `refusal` | `reason` (`out_of_scope` / `low_confidence`) and the message shown to the customer |
| `error` | `code` (`all_backends_failed`, `stream_interrupted`, …), `partial` |
| `done` | `requestId`, `outcome`, `backend`, `model`, `fallbackUsed`, `usage{prompt,completion,total,source}`, `costUsd`, `latencyMs`, `ttftMs`, `intent`, `confidence`, remaining `quota` |

With `"stream": false` you get the same information as one JSON object.

## `POST /v1/chat/completions` (raw gateway, OpenAI-compatible)

```bash
curl -N http://localhost:3000/v1/chat/completions -H 'authorization: Bearer sk-acme-demo-7f3a9c' \
  -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"hi"}],"model":"auto"}'
```

It streams standard `chat.completion.chunk`s. The final chunk carries `usage` and an `x_router` block with backend, fallback, cost and trace.

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

## Errors

Every error has the shape `{"error": {"code", "message", "details?"}}`.

| status | code | when |
|---|---|---|
| 400 | `invalid_request` / `invalid_json` / `unknown_model` | bad input, with the field-level reason |
| 401 | `missing_api_key` / `invalid_api_key` | |
| 403 | `model_not_allowed` | the tenant asked for a tier its plan doesn't include |
| 413 | `payload_too_large` | body over 64 kB |
| 429 | `quota_exceeded` | includes the remaining quota, `resetsAt` and `Retry-After` |
| 502 | `all_backends_failed` | every backend errored, timed out or returned unusable output |
| 503 | `quota_unavailable` | the quota check itself failed, so the request is rejected (fail closed) |
