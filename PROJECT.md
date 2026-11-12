# PROJECT.md: state of the work, and how to pick it up

This is the hand-off file for any new session, human or agent. Read it first, then [CLAUDE.md](CLAUDE.md) for code conventions and invariants. Last updated 2026-11-12 (PRs #5 and #6 merged, but #6 merged into #5's branch after #5 had landed, so the console refactor reaches `main` only through the router-modes PR, branch `feat/auto-routing-modes`, which is stacked on it).

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
- [x] **Merge PR #2** (PII guardrail, Claude-Console redesign). Merged 2026-11-11.
- [x] **Merge PR #3** (chat completions + `stream` toggle in the playground, logo reverted).
- [x] **Merge PR #4** (OpenAI SDK compatibility, Quotas redesign, orange theme).
- [x] **Merge PR #5** (clean architecture, complexity-based routing, error catalog + docs/ERRORS.md). Merged 2026-11-11.
- [x] **PR #6** (console clean architecture) merged 2026-11-11, but into PR #5's branch, not `main`.
- [ ] **Merge the router-modes PR** (`feat/auto-routing-modes`: `auto-smart` and `auto-cascade`, plus PR #6's commits). Redeploys Render and wipes SQLite (accepted).
- [ ] Refresh the README screenshots other than Quotas: they still show the old blue accent.
- [ ] Optional: judged quality eval across the router modes: `npm run eval -- --configs auto:v3,auto-smart:v3,auto-cascade:v3 --judge groq-strong --delay 17000` (~30 min on the free tier). The live router-modes run measured cost and outcome only.
- [ ] Before recording or submitting, sign in on the live console as `ops@nalar.example` and click **Run sample traffic** on the Reliability page. The Render disk is ephemeral, so metering is empty after every redeploy.
- [ ] Add a short "Beyond the brief" section to `docs/REPORT.md`: sign-in/RBAC, API key management, PII guardrail, console redesign. Say why each was added and what it cost, so it reads as judgement rather than scope creep.
- [ ] Submit: repo link, live URL, video link

## Brief requirements vs status

### Gateway
- [x] Chat endpoint with streaming, authenticated by a per-tenant API key: `POST /v1/chat/completions` (OpenAI-compatible: JSON by default, SSE with `stream: true`) and `POST /v1/support/answer` (SSE)
- [x] Per-tenant quota that fails closed with a clear error: monthly tokens and requests, atomic reservation, 429 `quota_exceeded` with `Retry-After`, 503 `quota_unavailable` on any DB error (`apps/gateway/src/quota.ts`)
- [x] Metering per request (model, tokens, latency, estimated cost, outcome) in a database: SQLite `requests` plus per-attempt `attempts`, with `usage_source` as provider, estimated, mixed or none

### Routing
- [x] Two or more backends with rules you can defend: groq-fast (gpt-oss-20b), groq-strong (gpt-oss-120b), local-qwen (Qwen3.5-4B on MLX), and mock (extractive). Default is fast; escalate to strong on a complexity score (length, ambiguous retrieval, reasoning cues…); tenant plan entitlement; explicit pins (`apps/gateway/src/domain/routing/policy.ts`). Three auto modes: `auto` (heuristic), `auto-smart` (classifier call), `auto-cascade` (fast first, escalate before commit on the fast model's own doubt).
- [x] Fallback on failure or slowness, recorded and inspectable: first-token and total timeouts, circuit breaker, fault injection, `attempts` table, route strip and drawer in the console

### Support assistant
- [x] Retrieval over the KB slice: BM25 with typo correction, 2,160 entries
- [x] Returns the answer, detected intent, retrieved entries, and a confidence signal (0.45·vote + 0.35·coverage + 0.2·model)
- [x] Handles unusable model output (falls back) and refuses when confidence is low: a validated JSON header before streaming, a coverage check for short off-topic messages, the model's `unknown` label, and a confidence threshold of 0.5

### Console (React + Vite, Node back end)
- [x] Playground with a streamed answer and: served-by model, whether fallback fired, retrieved entries, intent, tokens, latency, cost. Also model reasoning, a step trace, filled placeholders and the PII guardrail. It runs the **support assistant** (the brief's "what was retrieved, the intent" only exist there), through the signed-in session, metered like an API call.
- [x] Usage view with requests and cost per tenant plus remaining quota: the Monitor pages (Usage, Cost, Reliability, Logs) and Quotas (meters per tenant)

### Beyond the brief (added 2026-11-11; call out in the report)
- Console sign-in, four roles (operator, owner, developer, viewer), sessions + CSRF, tenant isolation, audit log
- API key management: scoped, expiring keys shown once, quickstart for both endpoints
- PII guardrail: mask / block / off per tenant on every model-calling path
- Console redesign after the Claude Console, a feature tour, a Pareto chart

### Evaluation
- [x] About 30 held-out cases, with a script reporting intent accuracy, answer quality (ROUGE-L + LLM judge), latency and cost (`tools/eval/eval.ts`)
- [x] Two configurations compared: fast vs strong, prompt v1 vs v2, v2-raw vs v3-rendered, local vs cloud (`docs/EVALUATION.md`)

### Constraints
- [x] At least one real model serving real requests (Groq) · a mock backend with configurable latency and failure (chaos)
- [x] Deployed (Render)
- [x] Cut scope deliberately and said so (REPORT §6–7)

## Current state

- **Code:**
  - npm-workspaces monorepo: `apps/gateway` (Express 5, TypeScript, `node:sqlite`), `apps/console` (React 19, Vite 8, Astryx 0.7.13, hand-rolled SVG charts), `tools/eval`
  - **72 gateway tests** pass (incl. sign-in, sessions, CSRF, RBAC, tenant isolation, API keys, PII guardrail and error hygiene); CI (GitHub Actions) runs typecheck, tests, build and the retrieval eval
- **Branches:** `main` has PR #1 (auth, RBAC, keys, first redesign). PR #2 (PII guardrail, governance pages, Claude-Console layout) is merged. PR #3 (chat playground, `stream` toggle) is merged. PR #4 (OpenAI compat, Quotas, orange theme) is merged. PR #5 (`refactor/clean-architecture-router`) is open.
- **Default prompt is v3:** it tells the model which placeholders the gateway can fill. v1 and v2 are kept for reproducible comparisons.
- **Tenants:**
  - `acme` (pro), `globex` (free), `initech` (trial: 4k tokens / 5 requests, to demo exhausting the quota) and `eval` (shown as "Nalar internal", the operator's home tenant)
  - acme and eval share a company profile that fills placeholders; initech has none on purpose, to show the fallback phrases
  - API keys are in README "Demo tenants" (seeded as ordinary `api_keys` rows). The console never receives a key or the admin token.
- **Console auth (PR #1):**
  - Email + password sign-in, sessions (HttpOnly cookie + CSRF token), RBAC with four roles, tenant isolation, and an audit log.
  - Scoped, expiring API keys created in the console.
  - Four demo accounts, one per tenant and role, listed in README "Console sign-in, roles and API keys": `ops@nalar.example` (operator), `owner@acme.example`, `dev@globex.example`, `viewer@initech.example`.
  - `/api/demo-config` was removed: it exposed the admin token and every key to anonymous visitors.
- **Guardrails (PR #2):**
  - PII masking (mask / block / off per tenant) on every model-calling path. Values reach the provider only as `{{Customer Email}}`-style slots and are restored only in the support answer; cards, IDs and bank numbers come back only as "ending in 1234".
  - Only PII types and counts are stored (`requests.pii`).
  - Governance API; Guardrails, Access and Audit log pages; operators' cross-tenant reads are audited; the audit log exports to CSV.
- **Console (PR #2):**
  - Claude-Console layout: a top bar with a ⌘K palette, notifications and docs, and a sectioned sidebar.
  - Pages: Dashboard; Usage / Cost / Reliability (Pareto) / Logs / Quotas; a workbench playground with templates; Guardrails / Access / Audit log; Backends / Evaluations.
  - Dark by default; Inter + Source Serif 4. Sign-in has the SparkTrail from the user's stackbyte website.
  - PR #3: the playground calls support answer or chat completions, with a `stream: true|false` toggle and a Raw tab; the original gradient logo is back.
  - PR #4: orange accent everywhere (the sign-in page's `#d97757`; light mode `#b4532f` for 4.5:1 text contrast), Astryx controls included; the logo gradient is orange. Quotas redesigned as stat cards plus a tenant table with a "Rejecting requests" status.
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
| Console uses sessions, not keys | the old demo-config handed every key and the admin token to the browser. The playground goes through `/api/console/playground/support`, the same capability path as `/v1/support/answer`. The user decided against an "API key test" field in the playground. |
| PII: mask and restore, not just redact | the provider never sees the value, but the customer still reads a natural answer. Restore goes through the existing placeholder renderer, so there is one mechanism, not two. Block is offered for strict tenants. |
| PII detectors are conservative | a masked order number would break answers; checksums and context keep false positives at 0 on the dataset. No name detection (needs NER). |
| Astryx for controls, our own CSS for layout | the user asked for Astryx; versions are pinned (beta). `layers.css` sets cascade order so our resets lose to Astryx and our classes win. |
| Claude-Console look | the user supplied Claude Console screenshots as the reference: dark default, chips, stat cards, workbench playground. |
| Original logo, not the spark mark | the spark mark from PR #2 looked too close to the Claude Console's. The layout stays; only the mark went back to the gradient fan-out. |
| Console in the same layers | pages called `fetch` through a shared `api()` with URLs spread across 15 files, and rules (quota level, backend status, the playground reducer) lived inside components. Now they sit behind one `ConsoleApi` port and in pure domain functions with tests. The bell and the Quotas page share one quota rule. |
| Clean architecture, enforced by a test | the gateway grew to about 4.7k lines with use cases reaching into SQLite and Express. Layers (domain / application / infrastructure / interfaces) with ports make the rules unit-testable and Postgres a new adapter, not a rewrite. `tests/architecture.test.ts` fails the build on an outward import. |
| Complexity-based auto routing, as a heuristic | weighted signals (length, ambiguity, several questions, reasoning cues, steps, constraints, code, math) instead of a classifier: free, no added latency, replayable, every decision explains itself. Weights keep the two original rules escalating on their own; `npm run routing-eval` showed no route change on the 43 eval messages. |
| Two more auto modes, measured honestly | the user asked for a smarter auto. `auto-smart` (fast-model classifier, metered, falls back to the heuristic) and `auto-cascade` (escalate at the header, before commit). The first live run exposed a flaw in each (cascade escalated on a retrieval-dominated score; classifier v1 escalated FAQ questions); both fixed and re-measured. Result: on this support task neither changes outcomes beyond noise and both cost ~40% more, so `auto` stays the default. Refusals are bounded by retrieval, not by the model (EVALUATION runs 7–8). |
| Error catalog | `GatewayError` only accepts a code from `ERROR_CATALOG`, a test ties it to docs/ERRORS.md, and process-level failures (port in use, uncaught errors, SIGTERM) drain and exit cleanly. |
| OpenAI compatibility is tested with the real SDK | `stream` used to default to `true`, so `client.chat.completions.create()` without `stream` got SSE and broke. Now it follows OpenAI: JSON by default, `stream_options`, `max_completion_tokens`, text parts, `developer`, sampling params, `/v1/models`, OpenAI error `type`. `tests/openai-sdk.test.ts` runs the `openai` package against the gateway. Tools, `response_format` and images are rejected by name. |
| Ephemeral SQLite on Render is accepted for now | the user decided a redeploy wiping usage is fine for the demo; Litestream → R2 or a paid disk are the options when it isn't. |
| Playground covers both endpoints and `stream` | the completions endpoint had no place in the console; the playground now calls either one, streamed or as JSON, and the Raw tab shows the exact wire body. Still session-authed: the console twin of each `/v1` route uses the same spec. |

## Known issues and limitations

- **Groq free tier:** 8k tokens/min **per model, shared by every caller on the key** (local runs, evals, the Render instance). Evals need `--delay 17000`; heavy use triggers 429 → fallback (handled, but it skews eval comparisons).
- **Render free tier:** about a minute of cold start after 15 min idle; SQLite resets on every redeploy or spin-down.
- **Bitext template quirk:** some answers repeat a UI label ("'My Orders' or 'My Orders' section"). Not fixed; it needs buffering across streamed chunks.
- **Hand-offs:** multi-intent, vague and Indonesian messages are refused with a hand-off instead of answered. This is deliberate and documented.
- **Judge score:** v3 scores about 0.1 lower than v2-raw. The judge compares against template references; this is documented and not hidden.
- **Token estimate:** chars/4 runs 6–17% high vs the provider. That's the safe direction for quota; such rows are labelled `estimated`.
- **groq-strong empty answers:** gpt-oss-120b sometimes ends a support turn (prompt v3) with no content after about 240 tokens. The gateway rejects it (`unusable_output`) and falls back to fast, so escalated requests may still be served by fast. Seen 3/3 on the comparison example on 2026-11-11, then 1 of 41 strong attempts across the two router-modes runs on 2026-11-12 (the same message); see REPORT §3.
- **auto-smart classifier:** not fully stable at temperature 0 (two identical messages got different labels), and the prompt-injection message made it reply unparseably once (the heuristic then decided, as designed). The v2 prompt is written for support traffic.
- **Chat endpoint:** `/v1/chat/completions` is OpenAI's Chat Completions format (tested with the `openai` SDK), not Anthropic's Messages format; no tools, `response_format` or images. It has no placeholder rendering. That's intentional: the raw path stays raw. It masks PII but does not restore it.
- **PII:** personal names aren't detected. A short message whose only content words sit next to PII can still be refused by the scope gate (lead-ins like "email me at" are already stripped for retrieval).
- **Auth:** the sign-in failure limiter is in memory (fine for one instance). Users are seeded; there is no user management or password change UI.
- **Console tests** cover the architecture and the domain rules; there are no component or end-to-end tests in CI (pages were smoke-tested with Playwright by hand).
- **Console bundle** is about 1 MB (Astryx + CodeBlock); code-splitting by page would fix the Vite warning.
- **Stale assets:** `docs/assets/console-overview.png` and `console-overview-dark.png` are no longer referenced; a safety check blocked the agent from deleting them. Run `git rm docs/assets/console-overview*.png`.

## Next steps (in priority order)

- [ ] Merge the router-modes PR; on Render check sign-in, the "Plain words, hard problem" template as Auto vs Auto · smart (Routing tab shows the classifier verdict), and the OpenAI SDK against `https://nalar-router.onrender.com/v1` (`/v1/models` lists the three modes).
- [ ] Measure how often `groq-strong` returns an empty answer under prompt v3 (seen 3/3 on the comparison example), then try `reasoning_effort: medium` for the strong tier.
- [ ] REPORT.md "Beyond the brief" section (see the checklist above).
- [ ] Record the video demo (user). Optionally script it with `.agents/skills/product-demo` (writes to `out/product-demo/`).
- [ ] Invite the assessors; rotate the Groq key.
- [ ] Re-run a clean v2-raw vs v3 eval when Groq isn't rate-limited (it would replace the contaminated `08-35-26` run as the second clean data point).
- [ ] Provider-level circuit breaker (both Groq backends fail together; that cost 14 s in one eval case).
- [ ] Postgres metering, so the live dashboard survives redeploys.
- [ ] Multi-intent splitting; language detection plus translated retrieval for Indonesian.
- [ ] A harder, paraphrased eval set (the in-domain set is close to saturated at 100%).
- [ ] Collapse the duplicated "'X' or 'X'" UI labels in rendered answers.

### Suggested demo flow (about 5 minutes)

1. Sign in as `ops@nalar.example` (move the cursor over the spark trail). Dashboard, then Reliability: run sample traffic, walk the Pareto and trends.
2. Playground: the "Cancel an order" template, then "Mask personal data". Show the inspector: routing, trace, intent and confidence, filled placeholders, and the PII guardrail (the provider saw `{{Customer Email}}`; the answer has the real email).
3. Refusals: the off-topic and prompt-injection templates (no model call for off-topic).
4. Fallback: Backends → set `groq-fast` to `hang` or `garbage`, run again, show the fallback trail; Logs shows the route strip.
5. Quota: Initech until it returns 429; Quotas shows the meter turn red, and the bell lights up.
6. Governance, 45 s: Guardrails (switch to block and try the tester), the audit log entry for it, then sign in as the viewer to show RBAC.
7. Get code → curl with an API key from the API keys page; Evaluations plus the report's numbers, 30 s.

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

### 2026-11-11

| what |
|---|
| Console sign-in, sessions, CSRF, RBAC (4 roles), tenant isolation, audit log, scoped expiring API keys with a quickstart; security headers and error hygiene; removed `/api/demo-config`. Astryx controls, Lucide icons, animated charts, Pareto, feature tour. PR #1, merged. |
| PII guardrail (mask / block / off), governance API, Guardrails / Access / Audit log pages, cross-tenant read audit, CSV export. Two leaks caught by tests and fixed (PII in a trace event; lead-in words causing scope refusals). |
| Claude-Console redesign (top bar, ⌘K, sectioned sidebar, Dashboard, Usage / Cost / Reliability / Logs / Quotas, workbench playground), sign-in focus-ring fix, SparkTrail on sign-in, refreshed README screenshots. PR #2, merged. |
| Playground calls either public endpoint: an Endpoint picker (support answer / chat completions), the `POST` path beside the title, a `stream: true\|false` toggle, an editable system prompt for chat, a Raw tab with the exact SSE or JSON body, and stream-aware Get code. Console route `/api/console/playground/chat`; chat SSE trace comments now carry `t`. Logo reverted to the original gradient fan-out mark (the spark mark looked too much like the Claude Console). PR #3. |

The full commit history is in `git log`. Every commit since 14:19 on 2026-11-10 is scoped.
