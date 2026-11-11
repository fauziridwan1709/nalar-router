# CLAUDE.md

**Starting a new session? Read [PROJECT.md](PROJECT.md) first.** It has the current state, the checklist, environment setup, the decisions log and the next steps.

This file is for coding agents working in **nalar-router**. It is an npm-workspaces monorepo for a small LLM gateway with a customer-support capability on top.

## Layout

```
apps/gateway/     Node ≥22.13 + Express 5 API (TypeScript → dist/). Serves the console build too.
  src/config.ts      every tunable: backends, prices, timeouts, routing thresholds, confidence gate
  src/http/          app.ts (routes, auth, shared capability handler), sink.ts (SSE), chatFormat.ts (OpenAI wire format)
  src/router/        policy.ts (which backends, in what order), executor.ts (fallback/timeouts/attempt metering), breaker.ts
  src/backends/      openaiCompat.ts (Groq, MLX, Ollama…), mock.ts (extractive), chaos.ts (fault injection)
  src/support/       retrieval.ts (BM25 + typo correction), prompt.ts (v1/v2/v3), parser.ts (header validation),
                     placeholders.ts (slot filling), assistant.ts
  src/auth/          passwords.ts (scrypt), sessions.ts (users, sessions, audit), rbac.ts (roles → permissions),
                     apiKeys.ts (scoped, expiring keys; digest only), rateLimit.ts (sign-in failures)
  src/http/console.ts  session-authed console API: sign-in, RBAC, tenant scoping, keys, playground
  src/http/capability.ts  the shared validate → admit → run → meter path (API key and console both use it)
  src/http/security.ts    CSP and security headers, cookies, CSRF / origin checks
  src/quota.ts       fail-closed admission + token reservations
  src/metering.ts    requests/attempts rows
  src/db.ts          node:sqlite schema + demo tenant seed
  tests/             vitest; scripted FakeBackend, no network
apps/console/     React 19 + Vite console (Playground / Usage / Backends)
tools/eval/       prepare-data.ts, retrieval-eval.ts, eval.ts, probe.ts; results/ holds committed eval outputs
data/             kb.json (2,160 KB entries), eval.json (30 held-out), eval-ood.json, eval-hard.json, retrieval-holdout.json
docs/             REPORT.md (design + results), EVALUATION.md (all eval runs), ARCHITECTURE.md (Mermaid diagrams),
                  API.md, assets/ (banner, screenshots)
apps/console/src  main.tsx (Astryx Theme, sign-in gate, role-aware shell), SignIn, Tour (feature guide), context.tsx (pages + perms),
                  Overview (dashboard + Pareto), Playground (workbench + Get code), ApiKeys, AuditLog, Requests, Tenants,
                  Backends, Evaluations; charts.tsx (animated SVG charts), ui.tsx (Astryx Select wrapper, Lucide icons),
                  snippets.ts (API call samples), layers.css (cascade order vs Astryx)
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
- **Reasoning is diagnostic only.** `{type:"reasoning"}` chunks are forwarded as `reasoning` events. They are never parsed, never count as the commit point, and never become part of the answer. They do count as liveness for the first-token timer, and their tokens are metered.
- **The model never types contact details or ids.** It writes `{{placeholders}}`, and `PlaceholderRenderer` fills them from the message, the tenant profile, UI labels, or a fallback phrase. Create a fresh renderer for each attempt. Raw `{{…}}` must never reach the customer in `fill` mode.
- **Refusals are `StopRequest`, not errors.** They don't trip the circuit breaker and they don't fall back.
- **Every attempt is metered,** including failed ones. `usage_source` is `provider` only when the provider actually reported usage. Otherwise it is `estimated`, or `none` when the provider rejected the call outright.
- **Routing reasons are data.** If you add a rule, give it a `rule` id and a human-readable `reason` in `planRoute`, and add a test.
- Prices and thresholds belong in `config.ts`, not inline.
- **The server enforces access.** Every console route checks a permission from `auth/rbac.ts`; the console hiding a control is not the control. Non-operators are pinned to their own tenant, and another tenant's object returns the same 404 as a missing one.
- **The browser never gets a tenant API key or the admin token.** The console uses the session cookie + CSRF token; the playground goes through `/api/console/playground/support`.
- **Errors carry the least detail that still helps the caller.** Same 401 for unknown/revoked/expired keys and for wrong password/unknown account; 403 doesn't name the permission; upstream error text stays in the DB (operators only); 404 doesn't echo the path.
- **A key's plaintext leaves the server once,** in the `POST /api/console/keys` response. Only its SHA-256 is stored.

## Agent skills (`.agents/skills`, linked in `.claude/skills`)

- **Console UI work:** read `frontend-design` and `web-design-guidelines`; for React specifics, `vercel-react-best-practices`. Use Astryx components (`@astryxdesign/core/*`, pinned 0.7.13) for controls before hand-rolling one, and Lucide for icons. Every chart follows the dataviz rules already in `apps/console/src/charts.tsx`: validated palette, one axis, a tooltip, and a table view.
- **Gateway and API work:** `nodejs-backend-patterns` and `api-and-interface-design`. Keep the error shape and the invariants above.
- **Always:** `karpathy-guidelines` (surgical changes, verifiable success criteria).
- **Verifying the running console:** `webapp-testing`. To record the demo video: `product-demo`.

## Conventions

- Commits use Conventional Commits with the part touched as the scope: `feat(gateway): …`, `fix(console): …`, `docs(readme): …`, `test(gateway): …`, `chore(eval): …`, `ci: …`. Split commits by part.
- ESM everywhere. The gateway uses `.js` suffixes in relative imports (NodeNext).
- Errors use `GatewayError(status, code, message, details)` and come out as `{error:{code,message,details}}`.
- New backends implement `Backend.stream()` and yield `{type:"text"}` and `{type:"usage"}` chunks. They must honour `req.signal`.
- When you change routing, prompts or retrieval, re-run `npm run retrieval-eval` and a short `npm run eval -- --limit 10`, and update `docs/REPORT.md` if the numbers move.
- Secrets live only in `.env` or the Render dashboard. The `DEMO_MODE` keys and demo account passwords are public demo values.
