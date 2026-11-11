# PROJECT.md: state of the work, and how to pick it up

This is the hand-off file for any new session, human or agent. Read it first, then [CLAUDE.md](CLAUDE.md) for code conventions and invariants. Last updated 2026-11-10.

## What this is

This repo is the **Mekari AI Builder take-home** ("Code Challenge: Mini Inference Router"). The brief asks for:
- a small LLM gateway with tenant auth, quota, metering, routing and fallback,
- a customer-support assistant on top of it, built on the Bitext dataset,
- a React console,
- an evaluation across two configurations,
- a deployment, a technical report, and a video demo.

The goal is to **stand out**, so judgement and honesty are part of what's assessed: say what was built, what was measured, and what was cut.

| | |
|---|---|
| Name | **nalar-router** (Indonesian *nalar* = reason, common sense). The user picked it after rejecting generic names. |
| Repo | https://github.com/fauziridwan1709/nalar-router (**private**) |
| Live | https://nalar-router.onrender.com (Render free web service, auto-deploys from `main`) |
| Local path | `~/claude/nalar-router` |
| Docs | [README](README.md) · [REPORT](docs/REPORT.md) · [EVALUATION](docs/EVALUATION.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [API](docs/API.md) |

## Deliverables checklist

- [x] GitHub repository with source and documentation
- [x] Technical report: routing rules, model and retrieval choices, evaluation, trade-offs (`docs/REPORT.md`)
- [x] Deployed URL that works (smoke-tested live: auth, 403, 429, SSE streaming, fallback via chaos, placeholders, metrics)
- [ ] **Video demo**, owned by the user. Use the `product-demo` skill, or record by hand. Suggested 5-minute flow is below.
- [ ] **Invite the assessors** to the private repo (GitHub → Settings → Collaborators), or make it public
- [ ] **Rotate the Groq API key.** It was printed in a session transcript on 2026-11-10. Update `.env` and the Render env var.
- [ ] Before recording or submitting, open the live console and click **Run sample traffic**. The Render disk is ephemeral, so metering is empty after every redeploy.
- [ ] Submit: repo link, live URL, video link

## Brief requirements vs status

### Gateway
- [x] Chat endpoint with streaming, authenticated by a per-tenant API key: `POST /v1/chat/completions` (OpenAI-compatible SSE) and `POST /v1/support/answer` (SSE)
- [x] Per-tenant quota that fails closed with a clear error: monthly tokens and requests, atomic reservation, 429 `quota_exceeded` with `Retry-After`, 503 `quota_unavailable` on any DB error (`apps/gateway/src/quota.ts`)
- [x] Metering per request (model, tokens, latency, estimated cost, outcome) in a database: SQLite `requests` plus per-attempt `attempts`, with `usage_source` as provider, estimated, mixed or none

### Routing
- [x] Two or more backends with rules you can defend: groq-fast (gpt-oss-20b), groq-strong (gpt-oss-120b), local-qwen (Qwen3.5-4B on MLX), and mock (extractive). Default is fast; escalate to strong on long messages or ambiguous retrieval; tenant plan entitlement; explicit pins (`apps/gateway/src/router/policy.ts`).
- [x] Fallback on failure or slowness, recorded and inspectable: first-token and total timeouts, circuit breaker, fault injection, `attempts` table, route strip and drawer in the console

### Support assistant
- [x] Retrieval over the KB slice: BM25 with typo correction, 2,160 entries
- [x] Returns the answer, detected intent, retrieved entries, and a confidence signal (0.45·vote + 0.35·coverage + 0.2·model)
- [x] Handles unusable model output (falls back) and refuses when confidence is low: a validated JSON header before streaming, a coverage check for short off-topic messages, the model's `unknown` label, and a confidence threshold of 0.5

### Console (React + Vite, Node back end)
- [x] Playground with a streamed answer and: served-by model, whether fallback fired, retrieved entries, intent, tokens, latency, cost. Also model reasoning, a step trace and filled placeholders.
- [x] Usage view with requests and cost per tenant plus remaining quota: the Overview dashboard has charts, and the Tenants page has quota meters

### Evaluation
- [x] About 30 held-out cases, with a script reporting intent accuracy, answer quality (ROUGE-L + LLM judge), latency and cost (`tools/eval/eval.ts`)
- [x] Two configurations compared: fast vs strong, prompt v1 vs v2, v2-raw vs v3-rendered, local vs cloud (`docs/EVALUATION.md`)

### Constraints
- [x] At least one real model serving real requests (Groq) · a mock backend with configurable latency and failure (chaos)
- [x] Deployed (Render)
- [x] Cut scope deliberately and said so (REPORT §6–7)

## Current state

- **Code:**
  - npm-workspaces monorepo: `apps/gateway` (Express 5, TypeScript, `node:sqlite`), `apps/console` (React 19, Vite 8, hand-rolled SVG charts), `tools/eval`
  - **72 gateway tests** pass (incl. sign-in, sessions, CSRF, RBAC, tenant isolation, API keys, PII guardrail and error hygiene); CI (GitHub Actions) runs typecheck, tests, build and the retrieval eval
- **Default prompt is v3:** it tells the model which placeholders the gateway can fill. v1 and v2 are kept for reproducible comparisons.
- **Tenants:**
  - `acme` (pro), `globex` (free), `initech` (trial: 4k tokens / 5 requests, to demo exhausting the quota) and `eval`
  - keys are in README "Demo tenants". The console no longer receives keys: it signs in (see below).
- **Console auth (added 2026-11-11):** email + password sign-in, sessions (HttpOnly cookie + CSRF token), RBAC with four roles, tenant isolation, audit log, scoped expiring API keys created in the console. Four demo accounts (README "Console sign-in, roles and API keys"), one per tenant and role: `ops@nalar.example` (operator), `owner@acme.example`, `dev@globex.example`, `viewer@initech.example`.
- **Guardrails (2026-11-11, later):** PII masking (mask / block / off per tenant) on every model-calling path, with values restored only in the support answer; governance API and Guardrails, Access and Audit log pages; audit of operators' cross-tenant reads; CSV export. 72 gateway tests.
- **Console redesign 2 (2026-11-11):** Claude-Console layout (top bar with ⌘K, sectioned sidebar, Dashboard, Usage / Cost / Reliability / Logs / Quotas, workbench playground with templates), dark by default, Inter + Source Serif 4, sign-in page with the stackbyte SparkTrail.
- **Console UI (2026-11-11):** Astryx design system controls, Lucide icons, workbench-style playground with Get code, animated charts plus a Pareto chart, a spotlight feature tour. `/api/demo-config` was removed: it exposed the admin token and every key to anonymous visitors.
  - acme and eval share a company profile that fills placeholders; initech has none on purpose, to show the fallback phrases
- **Headline numbers:**
  - groq-fast vs groq-strong: intent accuracy 100% vs 100%, judge 4.47 vs 4.53, cost $0.092 vs $0.185 per 1k requests
  - answers showing raw placeholders: 15/30 → 0/30
  - hard-case probe: 8/8
  - BM25 alone: 94.7% intent accuracy on 1,350 held-out rows

### Environment for a new session

| thing | where / how |
|---|---|
| Secrets | repo-root `.env` (gitignored): `GROQ_API_KEY`, `LOCAL_LLM_ENABLED=true`. On Render: dashboard env vars (`NODE_VERSION=24`, `GROQ_API_KEY`, `DEMO_MODE=true`, `ADMIN_TOKEN`). |
| Local model | `~/.venvs/mlx/bin/mlx_lm.server --model mlx-community/Qwen3.5-4B-MLX-4bit --port 8080` (model cached in `~/.cache/huggingface`, 2.9 GB). Ollama also has `qwen3.5:4b` if needed. |
| Run locally | `npm install && npm run build && npm start`, then http://localhost:3000 |
| Dev | `npm run dev` (gateway) and `npm run dev:console` (Vite on :5173) |
| GitHub CLI | `gh` logged in as `fauziridwan1709` (keyring) |
| Render | the account has a card on file (needed even for the free tier). The service `nalar-router` was created by hand (Web Service, not Blueprint): build `npm ci && npm run build`, start `npm start`, health `/healthz`. |
| Screenshots | Playwright scripts live outside the repo in `/tmp/shots` (playwright-core + system Chrome). Recreate if needed; README images are in `docs/assets/`. |

## Conventions

- **Commits:** Conventional Commits, with the part touched as the scope: `feat(gateway)`, `fix(console)`, `test(gateway)`, `chore(eval)`, `chore(skills)`, `docs`, `ci`. Split commits by part. End each message with the Co-Authored-By line. (Early commits before 14:19 predate this rule and were not rewritten.)
- **Agent skills** in `.agents/skills` (pinned in `skills-lock.json`; restore with `npx skills experimental_install`):
  - product-demo, karpathy-guidelines
  - console: frontend-design, web-design-guidelines, vercel-react-best-practices, webapp-testing
  - gateway: nodejs-backend-patterns, api-and-interface-design

  CLAUDE.md says which to use when.
- **Charts** follow the dataviz method: a validated palette (reference surfaces; light mode needs visible labels or a table), one axis, a tooltip and a table view on every chart, and status shown by icon plus label.
- **Invariants** are in CLAUDE.md: quota fails closed; one commit point per attempt; header validated before streaming; reasoning is diagnostic only; the model never types contact details or ids; refusals are `StopRequest`.
- **Honesty rule for docs:** report the numbers as measured, including the ones that look worse (judge −0.1 for v3, the rate-limited run). Don't fabricate traffic or history.

## Decisions log (why things are the way they are)

| decision | why |
|---|---|
| Groq gpt-oss-20b/120b as the hosted models | free tier, OpenAI-compatible; Groq's Llama models became enterprise-only. gpt-oss reasoning tokens are billed either way, so `include_reasoning` only controls whether we receive them. |
| Qwen3.5-4B via MLX for local | the user asked for MLX. On the cloud deployment it is listed as offline ("runs on a local machine"). |
| BM25, not embeddings | templated Bitext questions; 99.6% recall@8; deterministic; no second provider in the request path |
| Default to the fast tier | the eval showed strong gives no accuracy gain at 2× the cost |
| Coverage check only for messages of 6 terms or fewer | the hard-case probe found long, chatty in-domain messages wrongly refused (6/8 → 8/8 after the fix) |
| Gateway fills placeholders, not the model | so the model can't invent phone numbers or URLs; leaks 15/30 → 0/30 |
| SQLite, ephemeral on Render | real transactions keep quota correct and simple. Trade-off documented; Postgres is the next step. |
| Fallback only before the first byte | never splice two models' text; a `partial` outcome instead |
| Render, card added | Vercel serverless doesn't fit SSE plus SQLite; the user chose to add a card rather than switch hosts |
| Private repo | the user's choice; assessors need an invite, and the CI badge only shows for viewers with access |

## Known issues and limitations

- **Groq free tier:** 8k tokens/min **per model, shared by every caller on the key** (local runs, evals, the Render instance). Evals need `--delay 17000`; heavy use triggers 429 → fallback (handled, but it skews eval comparisons).
- **Render free tier:** about a minute of cold start after 15 min idle; SQLite resets on every redeploy or spin-down.
- **Bitext template quirk:** some answers repeat a UI label ("'My Orders' or 'My Orders' section"). Not fixed; it needs buffering across streamed chunks.
- **Hand-offs:** multi-intent, vague and Indonesian messages are refused with a hand-off instead of answered. This is deliberate and documented.
- **Judge score:** v3 scores about 0.1 lower than v2-raw. The judge compares against template references; this is documented and not hidden.
- **Token estimate:** chars/4 runs 6–17% high vs the provider. That's the safe direction for quota; such rows are labelled `estimated`.
- **Chat endpoint:** `/v1/chat/completions` is single-model streaming, with no placeholder rendering. That's intentional: the raw path stays raw.

## Next steps (in priority order)

- [ ] Record the video demo (user). Optionally script it with `.agents/skills/product-demo` (writes to `out/product-demo/`).
- [ ] Invite the assessors; rotate the Groq key.
- [ ] Re-run a clean v2-raw vs v3 eval when Groq isn't rate-limited (it would replace the contaminated `08-35-26` run as the second clean data point).
- [ ] Provider-level circuit breaker (both Groq backends fail together; that cost 14 s in one eval case).
- [ ] Postgres metering, so the live dashboard survives redeploys.
- [ ] Multi-intent splitting; language detection plus translated retrieval for Indonesian.
- [ ] A harder, paraphrased eval set (the in-domain set is close to saturated at 100%).
- [ ] Collapse the duplicated "'X' or 'X'" UI labels in rendered answers.

### Suggested demo flow (about 5 minutes)

1. Overview: run sample traffic, walk the charts.
2. Playground: a streamed answer with the inspector (routing, trace, intent and confidence, filled placeholders, reasoning).
3. Refusals: nasi goreng (no model call), and the angry customer (handed to a human).
4. Fallback: Backends → set `groq-fast` to `hang` or `garbage`, then send again in the Playground to show the fallback trail and route strip.
5. Quota: Initech until it returns 429; Tenants shows the meter turn red.
6. Evaluations page plus the report's numbers, 30 s.

## Work log (2026-11-10)

| time | what |
|---|---|
| 10:30–11:30 | Read the brief. Built the gateway (auth, quota, metering, routing, fallback, chaos), the support assistant (BM25, prompt, header parser, confidence, refusal), the console, the eval harness and 28 tests. Data split from the Bitext CSV. |
| 11:30–11:50 | Monorepo restructure (`apps/`, `tools/`, `docs/`, CLAUDE.md). Renamed to nalar-router; private repo created. |
| 11:50–12:25 | Groq eval (4 configs, judge). Hard-case probe found the coverage-check flaw, fixed; REPORT.md written. Render deploy (card added). |
| 13:00–13:35 | README banner, badges, Mermaid architecture, screenshots, CI. |
| 13:50–14:20 | Reasoning stream (Groq / MLX), step trace with server timings, online/offline backend labels. |
| 14:20–15:59 | Placeholder rendering (message → profile → UI label → fallback), prompt v3, tenant profiles; three eval runs; two rendering bugs found by the judge and fixed. |
| 16:00–16:25 | `.agents/skills` (8 skills); `/admin/metrics`; enterprise console redesign with charts (Overview, Requests route strip, Tenants, Backends, Evaluations); `docs/EVALUATION.md`. |

The full commit history is in `git log`. Every commit since 14:19 is scoped.
