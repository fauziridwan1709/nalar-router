# nalar-router

*Nalar* is Indonesian for "reason" or "common sense". nalar-router is an LLM gateway with common sense. It doesn't guess and it doesn't overspend.

It is a small LLM gateway with one capability on top of it: a customer-support assistant built on the
[Bitext customer-support dataset](https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset).

- **Gateway:** streaming chat with per-tenant API keys and a per-tenant monthly quota that fails closed. Every request is metered (model, tokens, latency, cost, outcome) in SQLite.
- **Router:** four backends: Groq `gpt-oss-20b` (fast), Groq `gpt-oss-120b` (strong), local Qwen3.5-4B on MLX, and a mock/extractive fallback. Routing rules are explicit, and the backends fall back to each other with first-token and total timeouts, a circuit breaker, and a record of every attempt.
- **Support assistant:** BM25 retrieval over 2,160 KB entries. It returns the answer, the intent, the retrieved entries and a confidence score. It refuses when confidence is low, and if a model's output is unusable it moves on to the next backend.
- **Console** (React): a playground that streams the answer and shows the routing decision, the fallback trail, the intent and confidence, what was retrieved, and tokens, latency and cost. A usage view shows requests, cost and remaining quota per tenant. A backends view lets you inject failures and watch fallback happen.
- **Eval:** 30 held-out cases plus 5 out-of-domain prompts, scored on intent accuracy, ROUGE-L, an LLM judge, latency and cost, across two configurations.

**Live:** https://nalar-router.onrender.com. It runs on Render's free tier, so the first request after 15 minutes idle takes about a minute.

**Headline results** (30 held-out cases plus 5 out-of-domain, run through the real gateway):

| | intent accuracy | LLM judge (1–5) | p50 latency | cost per 1k requests |
|---|---|---|---|---|
| gpt-oss-20b (fast, default) | 100% | 4.47 | 0.74 s | $0.092 |
| gpt-oss-120b (strong) | 100% | 4.53 | 0.79 s | $0.185 |

Both models refused all 5 out-of-domain cases and wrongly refused none of the 30 in-domain ones. The hard-case probe (prompt injection, angry, multi-intent, typo'd, Indonesian) scored 8/8. BM25 retrieval alone reaches 94.7% intent accuracy on 1,350 held-out rows.

The design reasoning, the full results and the trade-offs are in **[docs/REPORT.md](docs/REPORT.md)**.

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

## Repository layout

```
apps/gateway/   Express API: auth, quota, routing, fallback, metering, support assistant (TypeScript)
apps/console/   React + Vite console (playground, usage, backends and fault injection)
tools/eval/     data preparation, retrieval eval, end-to-end eval; results/ holds committed runs
data/           KB slice and held-out eval sets (generated from Bitext, seeded)
docs/           REPORT.md (design and results), API.md
CLAUDE.md       notes for coding agents: layout, commands, invariants
```

This is an npm-workspaces monorepo. Run every command from the repo root.

## Run it locally

Requires Node ≥ 22.13 (it uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env            # add GROQ_API_KEY; optionally enable the local model
npm run build                   # gateway (tsc) + console (vite)
npm start                       # http://localhost:3000  (console + API)
```

For development, run `npm run dev` (API with reload on :3000) and `npm run dev:console` (Vite on :5173, which proxies to the API).

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

The full reference is in [docs/API.md](docs/API.md). In short:

- `POST /v1/support/answer` is the support capability. It streams SSE: `route`, `retrieval`, `attempt`, `intent`, `token`, `refusal`, `done`.
- `POST /v1/chat/completions` is the raw gateway. It is OpenAI-compatible and adds an `x_router` block.
- `GET /v1/usage` returns the calling tenant's usage. The `/admin/*` endpoints cover usage, request inspection, backend health and fault injection.

## Evaluation and tests

```bash
npm test                                   # 29 unit + HTTP tests (scripted fake backends, no network)
npm run retrieval-eval                     # LLM-free retrieval accuracy on 1,350 held-out rows
npm run eval -- --base http://localhost:3000 --configs groq-fast:v2,groq-strong:v2 --judge groq-strong --delay 17000
npm run probe -w @nalar-router/eval -- --base http://localhost:3000 --model groq-fast   # 8 adversarial inputs
```

The eval writes results to `tools/eval/results/<timestamp>.{md,json}`. The headline numbers are in the report.

## Deploy (Render)

`render.yaml` is a blueprint for a single web service:

1. Create a Render Blueprint from this repository.
2. Set `GROQ_API_KEY` in the dashboard.
3. The service is built with `npm ci && npm run build` and started with `npm start`.

On the free plan the disk is ephemeral, so the SQLite metering data resets whenever the service redeploys or spins down. See the report for why that trade-off was accepted.
