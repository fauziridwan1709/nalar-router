# Mini Inference Router

This is a small LLM gateway with one capability on top of it: a customer-support assistant built on the
[Bitext customer-support dataset](https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset).

- **Gateway:** streaming chat with per-tenant API keys and a per-tenant monthly quota that fails closed. Every request is metered (model, tokens, latency, cost, outcome) in SQLite.
- **Router:** four backends: Groq `gpt-oss-20b` (fast), Groq `gpt-oss-120b` (strong), local Qwen3.5-4B on MLX, and a mock/extractive fallback. Routing rules are explicit, and the backends fall back to each other with first-token and total timeouts, a circuit breaker, and a record of every attempt.
- **Support assistant:** BM25 retrieval over 2,160 KB entries. It returns the answer, the intent, the retrieved entries and a confidence score. It refuses when confidence is low, and if a model's output is unusable it moves on to the next backend.
- **Console** (React): a playground that streams the answer and shows the routing decision, the fallback trail, the intent and confidence, what was retrieved, and tokens, latency and cost. A usage view shows requests, cost and remaining quota per tenant. A backends view lets you inject failures and watch fallback happen.
- **Eval:** 30 held-out cases plus 5 out-of-domain prompts, scored on intent accuracy, ROUGE-L, an LLM judge, latency and cost, across two configurations.

The design reasoning, the measured results and the trade-offs are in **[docs/REPORT.md](docs/REPORT.md)**.

```
                ┌───────────────────────────── gateway (Express, Node ≥22) ─────────────────────────────┐
 client ──POST──▶ auth (API key → tenant) → validate (zod) → capability.prepare → quota.admit (reserve) │
  (SSE)  ◀──────│        │                                    │ retrieval (BM25)    │ BEGIN IMMEDIATE    │
                │        ▼                                    ▼                     ▼                    │
                │   router.planRoute(tenant plan, signals) ─▶ executor: try chain[0] → chain[1] → …      │
                │        first-token timeout · total timeout · circuit breaker · bad-output check        │
                │                         │                                                            │
                │                         ▼                                                            │
                │   backends: groq-fast · groq-strong · local-qwen (MLX) · mock (extractive)             │
                │                         │                                                            │
                │   metering.finish → requests + attempts tables (SQLite) · release reservation        │
                └──────────────────────────────────────────────────────────────────────────────────────┘
```

## Run it locally

Requires Node ≥ 22.13 (it uses the built-in `node:sqlite`).

```bash
npm install && npm --prefix web install
cp .env.example .env            # add GROQ_API_KEY; optionally enable the local model
npm run build                   # server (tsc) + console (vite)
npm start                       # http://localhost:3000  (console + API)
```

For development, run `npm run dev` (API with reload on :3000) and `npm run dev:web` (Vite on :5173, which proxies to the API).

**Optional local model (Apple Silicon, MLX):**

```bash
python3 -m venv ~/.venvs/mlx && ~/.venvs/mlx/bin/pip install mlx-lm
~/.venvs/mlx/bin/mlx_lm.server --model mlx-community/Qwen3.5-4B-MLX-4bit --port 8080
# then in .env:  LOCAL_LLM_ENABLED=true
```

Ollama works as well: set `LOCAL_LLM_BASE_URL=http://localhost:11434/v1`, `LOCAL_LLM_MODEL=qwen3.5:4b` and `LOCAL_LLM_EXTRA_BODY={"reasoning_effort":"none"}`.

**Data.** `data/kb.json`, `data/eval.json` and the rest are committed. To regenerate them, download the CSV to `data/raw/bitext.csv` and run `npm run prepare-data`. The split is seeded and deterministic.

## Demo tenants

| tenant | key | plan / tiers | monthly quota |
|---|---|---|---|
| acme | `sk-acme-demo-7f3a9c` | pro: fast, strong, local, degraded | 300k tokens / 1,000 req |
| globex | `sk-globex-demo-41be02` | free: fast, local, degraded | 40k tokens / 100 req |
| initech | `sk-initech-demo-c0ffee` | trial: fast, degraded | 4k tokens / 5 req, so you can watch the quota run out |
| eval | `sk-eval-demo-e7a1` | internal: all tiers | 5M tokens |

Admin token: `ADMIN_TOKEN` (default `admin-demo-token`). With `DEMO_MODE=true` the console gets these keys from `/api/demo-config` so reviewers don't have to paste them in. That is deliberate for a demo and has to be off in a real deployment.

## API

### `POST /v1/support/answer` (the capability)

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

### `POST /v1/chat/completions` (raw gateway, OpenAI-compatible)

```bash
curl -N http://localhost:3000/v1/chat/completions -H 'authorization: Bearer sk-acme-demo-7f3a9c' \
  -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"hi"}],"model":"auto"}'
```

It streams standard `chat.completion.chunk`s. The final chunk carries `usage` and an `x_router` block with backend, fallback, cost and trace.

### Other endpoints

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

### Errors

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

## Evaluation and tests

```bash
npm test                                   # 28 unit + HTTP tests (scripted fake backends, no network)
npm run retrieval-eval                     # LLM-free retrieval accuracy on 1,350 held-out rows
npm run eval -- --base http://localhost:3000 --configs groq-fast:v2,groq-strong:v2 --judge groq-strong
```

The eval writes results to `eval/results/<timestamp>.{md,json}`. The headline numbers are in the report.

## Deploy (Render)

`render.yaml` is a blueprint for a single web service:

1. Create a Render Blueprint from this repository.
2. Set `GROQ_API_KEY` in the dashboard.
3. The service is built with `npm ci && npm --prefix web ci && npm run build` and started with `npm start`.

On the free plan the disk is ephemeral, so the SQLite metering data resets whenever the service redeploys or spins down. See the report for why that trade-off was accepted.
