# CLAUDE.md

**Starting a new session? Read [PROJECT.md](PROJECT.md) first.** It has the current state, the checklist, environment setup, the decisions log and the next steps.

This file is for coding agents working in **nalar-router**. It is an npm-workspaces monorepo for a small LLM gateway with a customer-support capability on top.

## Layout

```
apps/gateway/     Node ≥22.13 + Express 5 API (TypeScript → dist/). Serves the console build too.
                  Clean Architecture (Robert C. Martin), folders named after its circles; dependencies point
                  inward only (tests/architecture.test.ts enforces it). See docs/ARCHITECTURE.md §5.
  src/entities/        Enterprise Business Rules, pure, no I/O: types.ts, errors.ts (ERROR_CATALOG), tokens.ts,
                       quota.ts (decideAdmission), metering.ts (attempt/request records, summarize), reporting.ts (RANGES),
                       limits.ts (request size limits, shared with the console),
                       routing/ (policy.ts planRoute, complexity.ts assessComplexity, classifier.ts auto-smart prompt/parser,
                       cascade.ts auto-cascade rule, context.ts context windows, breaker.ts), guardrails/pii.ts,
                       auth/ (rbac.ts, apiKey.ts scopes/limits, user.ts session lifetimes, failureLimiter.ts),
                       support/ (retrieval.ts BM25, prompt.ts v1–v3, parser.ts header validation, placeholders.ts)
  src/use-cases/       Application Business Rules: capability.ts (prepare → admit → run → meter → respond), support.ts,
                       chat.ts, executor.ts (fallback/timeouts/attempts), router.ts (auto-smart classify + re-plan),
                       access.ts (API key auth, tenant scoping, redaction), identity.ts (sign-in/out, sessions),
                       apiKeys.ts, tenants.ts (quota, PII policy, members), observability.ts (metrics, logs, audit),
                       operations.ts (backend status, models, fault injection, evals), deps.ts (AppDeps, GatewayDeps),
                       ports/ (backend, sink, stores, tenants, identity, apiKeys, reporting, operations)
  src/interface-adapters/
    controllers/http/  api.ts (/healthz, /v1), console.ts (session API), admin.ts (admin token), specs.ts (zod schemas,
                       spec builders, Express transport), security.ts, request.ts, settings.ts (HttpSettings), shared.ts
    presenters/        sse.ts (support SSE), openaiChat.ts (OpenAI wire), httpError.ts (error presenter)
    gateways/          sqlite/ (quota, metering, metrics, reporting, tenants, apiKeys, sessions: port adapters),
                       llm/ (openaiCompat.ts, mock.ts, chaos.ts, health.ts), crypto/ (hash, passwords), files/ (evalResults)
  src/frameworks/      web/app.ts (Express app: hardening, mounting, static console, error presenter),
                       sqlite/db.ts (driver: schema, migrations, seed)
  src/main/            config.ts (env → settings), container.ts (composition root: createGateway), index.ts (server + shutdown)
  tests/               vitest; scripted FakeBackend, no network; architecture, errors and OpenAI SDK contract tests
apps/console/     React 19 + Vite console (layout below)
tools/eval/       prepare-data.ts, retrieval-eval.ts, eval.ts, probe.ts; results/ holds committed eval outputs
data/             kb.json (2,160 KB entries), eval.json (30 held-out), eval-ood.json, eval-hard.json, retrieval-holdout.json
docs/             REPORT.md (design + results), EVALUATION.md (all eval runs), ARCHITECTURE.md (Mermaid diagrams),
                  API.md, assets/ (banner, screenshots)
apps/console/src  Same circles; tests/architecture.test.ts enforces them (React only in frameworks/ and main.tsx):
  main.tsx             composition root: styles, createHttpConsoleApi(), <ApiProvider><App/>
  entities/            types (models.ts) and pure rules: format, access (grants, PAGES), quota (levelOf),
                       backends (backendState), outcomes (groupOf), playground (Turn, applyEvent, TRACE_LABEL), snippets,
                       limits (checkPlayground: field limits and the selected model's context window)
  use-cases/           ports.ts (ConsoleApi)
  interface-adapters/gateways/http/  client.ts (fetch, CSRF, ApiError mapping), consoleApi.ts (every endpoint),
                       playgroundStream.ts (SSE/JSON → events)
  frameworks/ui/       app/App.tsx (sign-in gate, top bar, ⌘K, sidebar), pages/ (Dashboard, Playground, ApiKeys, Usage, Cost,
                       Reliability, Logs, Quotas, Guardrails, Access, AuditLog, Backends, Evaluations, SignIn),
                       components/ (kit, charts, ui, StatusBadge, Tour, SparkTrail, palette), styles/ (styles.css, layers.css),
                       hooks/ (api.tsx ApiProvider/useApi, appContext.tsx, useMetrics.ts, useBackendStatus.ts)
```

## Commands (run from the repo root)

```
npm install
npm run dev                 # gateway with reload on :3000 (reads ./.env)
npm run dev:console         # vite on :5173, proxies /v1 /admin /api to :3000
npm test                    # gateway + console tests (must stay green)
npm run typecheck
npm run build && npm start  # production: one process serves the API and the console
npm run retrieval-eval      # LLM-free retrieval check, takes about 1 s
npm run routing-eval        # LLM-free: which tier each eval/example message starts on, and why
npm run router-modes-eval -- --base http://localhost:3000   # live: auto vs auto-smart vs auto-cascade on 17 messages
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
- **Router modes are `auto` (heuristic), `auto-smart` (classifier) and `auto-cascade` (fast first, escalate on an unsure header).** The classifier runs after admission and is metered as attempt 0 (`classified`); if it fails, times out or is unsure, the heuristic decides, and it never fails a request. A cascade escalation happens only before commit, is outcome `escalated`, and neither trips the breaker nor counts as fallback.
- **Routing reasons are data.** If you add a rule, give it a `rule` id and a human-readable `reason` in `planRoute`, and add a test. Complexity signals live in `entities/routing/complexity.ts` with their weights; after changing one, run `npm run routing-eval` and report the route changes.
- Prices and thresholds belong in `main/config.ts`, not inline.
- **The server enforces access.** Every console route checks a permission from `entities/auth/rbac.ts`; the console hiding a control is not the control. Non-operators are pinned to their own tenant, and another tenant's object returns the same 404 as a missing one.
- **The browser never gets a tenant API key or the admin token.** The console uses the session cookie + CSRF token; the playground goes through `/api/console/playground/support` and `/chat` (the same specs as the `/v1` routes, in `capability.ts`).
- **Errors carry the least detail that still helps the caller.** Same 401 for unknown/revoked/expired keys and for wrong password/unknown account; 403 doesn't name the permission; upstream error text stays in the DB (operators only); 404 doesn't echo the path.
- **PII never leaves the gateway unmasked under `mask`, and its values are never stored.** Scan before retrieval, routing and the prompt; restore only in the answer stream; trace events, logs and the `requests.pii` column carry types and counts, never values. Detectors must not mask order/invoice/tracking ids (tests cover this).
- **`/v1/chat/completions` and `/v1/models` stay OpenAI-compatible.** `stream` defaults to `false`, errors carry OpenAI's `type`, and `tests/openai-sdk.test.ts` (the real `openai` package) must pass. Extensions go in `x_router` or SSE comments, never in OpenAI's own fields.
- **A key's plaintext leaves the server once,** in the `POST /api/console/keys` response. Only its SHA-256 is stored.

## Agent skills (`.agents/skills`, linked in `.claude/skills`)

- **Console UI work:** read `frontend-design` and `web-design-guidelines`; for React specifics, `vercel-react-best-practices`. Use Astryx components (`@astryxdesign/core/*`, pinned 0.7.13) for controls before hand-rolling one, and Lucide for icons. Every chart follows the dataviz rules already in `apps/console/src/frameworks/ui/components/charts.tsx`: validated palette, one axis, a tooltip, and a table view.
- **Gateway and API work:** `nodejs-backend-patterns` and `api-and-interface-design`. Keep the error shape and the invariants above.
- **Always:** `karpathy-guidelines` (surgical changes, verifiable success criteria).
- **Verifying the running console:** `webapp-testing`. To record the demo video: `product-demo`.

## Conventions

- Commits use Conventional Commits with the part touched as the scope: `feat(gateway): …`, `fix(console): …`, `docs(readme): …`, `test(gateway): …`, `chore(eval): …`, `ci: …`. Split commits by part.
- ESM everywhere. The gateway uses `.js` suffixes in relative imports (NodeNext).
- Errors use `GatewayError(status, code, message, details)` and come out as `{error:{code,message,details}}`. `code` must be in `ERROR_CATALOG` (entities/errors.ts, typed) with the same status, and documented in docs/ERRORS.md; tests/errors.test.ts checks both.
- New code goes in the right circle: rules in `entities/`, orchestration in `use-cases/` (talking to the outside only through a port in `use-cases/ports/`), routes in `interface-adapters/controllers/http/` (parse, check permission, call one use case), output formats in `presenters/`, port implementations in `gateways/`. Express and SQLite are started only in `frameworks/`. Wire new adapters in `main/container.ts`.
- Console: pages get data only through `useApi()` (the `ConsoleApi` port). A new endpoint is a method on the port plus its HTTP implementation in `interface-adapters/gateways/http/consoleApi.ts`; logic worth testing goes in `entities/` as a pure function.
- New backends implement `Backend.stream()` and yield `{type:"text"}` and `{type:"usage"}` chunks. They must honour `req.signal`.
- When you change routing, prompts or retrieval, re-run `npm run retrieval-eval` and a short `npm run eval -- --limit 10`, and update `docs/REPORT.md` if the numbers move.
- Secrets live only in `.env` or the Render dashboard. The `DEMO_MODE` keys and demo account passwords are public demo values.
