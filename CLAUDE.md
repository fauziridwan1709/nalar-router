# CLAUDE.md

This file is for coding agents working in **Nalar**. Nalar is an npm-workspaces monorepo for a small LLM gateway with a customer-support capability on top.

## Layout

```
apps/gateway/     Node ≥22.13 + Express 5 API (TypeScript → dist/). Serves the console build too.
  src/config.ts      every tunable: backends, prices, timeouts, routing thresholds, confidence gate
  src/http/          app.ts (routes, auth, shared capability handler), sink.ts (SSE), chatFormat.ts (OpenAI wire format)
  src/router/        policy.ts (which backends, in what order), executor.ts (fallback/timeouts/attempt metering), breaker.ts
  src/backends/      openaiCompat.ts (Groq, MLX, Ollama…), mock.ts (extractive), chaos.ts (fault injection)
  src/support/       retrieval.ts (BM25 + typo correction), prompt.ts (v1/v2), parser.ts (header validation), assistant.ts
  src/quota.ts       fail-closed admission + token reservations
  src/metering.ts    requests/attempts rows
  src/db.ts          node:sqlite schema + demo tenant seed
  tests/             vitest; scripted FakeBackend, no network
apps/console/     React 19 + Vite console (Playground / Usage / Backends)
tools/eval/       prepare-data.ts, retrieval-eval.ts, eval.ts; results/ holds committed eval outputs
data/             kb.json (2,160 KB entries), eval.json (30 held-out), eval-ood.json, retrieval-holdout.json
docs/             REPORT.md (design + results), API.md
```

## Commands (run from the repo root)

```
npm install
npm run dev                 # gateway with reload on :3000 (reads ./.env)
npm run dev:console         # vite on :5173, proxies /v1 /admin /api to :3000
npm test                    # gateway tests (must stay green)
npm run typecheck
npm run build && npm start  # production: one process serves the API and the console
npm run retrieval-eval      # LLM-free retrieval check, takes about 1 s
npm run eval -- --base http://localhost:3000 --configs groq-fast:v2,groq-strong:v2 --judge groq-strong --delay 17000
```

Local model: `~/.venvs/mlx/bin/mlx_lm.server --model mlx-community/Qwen3.5-4B-MLX-4bit --port 8080`, then set `LOCAL_LLM_ENABLED=true` in `.env`.

## Invariants (do not break these)

- **Quota fails closed.** Any exception in `admit()` becomes 503 `quota_unavailable` and no model is called. Usage is always derived from the `requests` table. Do not add a separate counter.
- **There is one commit point per attempt.** Fallback is allowed only before `ctx.commit()` (the first byte sent to the client). After commit, errors end the request. Never splice output from two models together.
- **The support header is validated before streaming.** The intent must be in the label set (or `unknown`). Header and empty-answer failures raise `BackendError("unusable_output")`, which moves on to the next backend.
- **Refusals are `StopRequest`, not errors.** They don't trip the circuit breaker and they don't fall back.
- **Every attempt is metered,** including failed ones. `usage_source` is `provider` only when the provider actually reported usage. Otherwise it is `estimated`, or `none` when the provider rejected the call outright.
- **Routing reasons are data.** If you add a rule, give it a `rule` id and a human-readable `reason` in `planRoute`, and add a test.
- Prices and thresholds belong in `config.ts`, not inline.

## Conventions

- ESM everywhere. The gateway uses `.js` suffixes in relative imports (NodeNext).
- Errors use `GatewayError(status, code, message, details)` and come out as `{error:{code,message,details}}`.
- New backends implement `Backend.stream()` and yield `{type:"text"}` and `{type:"usage"}` chunks. They must honour `req.signal`.
- When you change routing, prompts or retrieval, re-run `npm run retrieval-eval` and a short `npm run eval -- --limit 10`, and update `docs/REPORT.md` if the numbers move.
- Secrets live only in `.env` or the Render dashboard. The `DEMO_MODE` keys are fake demo keys.
