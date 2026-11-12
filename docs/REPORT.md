# nalar-router: technical report

*Nalar* is Indonesian for "reason" or "common sense". The project is named for the two decisions it makes on every request: which model is worth paying for, and whether to answer at all.

- **Live:** https://nalar-router.onrender.com (Render free tier; the first request after 15 minutes idle takes about a minute)
- **Code:** `apps/gateway` (API), `apps/console` (React console), `tools/eval` (data prep and evals)
- **Raw eval output:** [`tools/eval/results/`](../tools/eval/results/)
- **Diagrams:** [ARCHITECTURE.md](ARCHITECTURE.md) (system overview, request lifecycle, routing decision, data model)

## 1. What I built, in one paragraph

A tenant calls `POST /v1/support/answer` with an API key. The gateway authenticates the key and validates the input. It retrieves similar KB entries with BM25, which costs almost nothing, and uses the retrieval signals to choose a route. It reserves quota atomically and fails closed. Then it streams from the first backend in the route chain that produces valid output. Each try is a separate attempt with a first-token timeout and a total timeout. Before any text reaches the client, the gateway checks the model's intent/confidence header: malformed output moves on to the next backend, and low confidence becomes a refusal with a hand-off message. Every attempt is written to SQLite with its tokens, latency, cost and outcome. The console replays all of this live. `POST /v1/chat/completions` exposes the same gateway path in OpenAI-compatible form for anything that isn't a packaged capability.

## 2. Request path and its failure behaviour

| step | behaviour on failure |
|---|---|
| auth (`Bearer` key → SHA-256 → tenant) | 401 `missing_api_key` / `invalid_api_key`. Keys are stored only as hashes. |
| validation (zod, strict) | 400 with field-level messages. Unknown fields are rejected, bodies are capped at 64 kB, and malformed JSON gets 400 `invalid_json`. Recorded as `rejected`; doesn't count against quota. |
| plan check | 403 `model_not_allowed` when a tenant asks for a tier its plan doesn't include. The request is rejected, not silently downgraded. |
| **quota admission** | One `BEGIN IMMEDIATE` transaction computes usage from the `requests` table plus in-flight reservations. It then either inserts the request row and a reservation, or returns 429 `quota_exceeded` with the remaining quota, `resetsAt` and `Retry-After`. **Any exception here returns 503 `quota_unavailable`, and no model is called (fail closed).** `max_tokens` is capped to the remaining budget. |
| retrieval gate | Short messages with very low lexical coverage are refused as out of scope without calling a model, at a cost of $0. |
| backend attempt | HTTP error, no first token within the timeout, total timeout, or unusable output: the gateway records the attempt and tries the next backend. Infrastructure failures feed a per-backend circuit breaker (3 consecutive failures open it for 30 s). |
| **commit point** | Fallback is only possible before the first byte of the answer is sent. After that, a failure ends the stream with an `error` event and the outcome `partial`. I never splice two models' outputs into one answer. |
| client disconnect | The upstream call is aborted. The request is metered as `client_aborted` with estimated tokens. |
| metering | One transaction writes the request row and its attempts and releases the reservation. |

The `requests` table is the single source of truth for both metering and quota. There is no separate counter that could drift.

**Observability beyond the answer.**

- **Step trace.** Every SSE event except tokens carries `t`, the server-side milliseconds since the request arrived. The console draws them as a trace: quota admitted, routed, retrieved, scope gate, each attempt, header validated, committed, done.
- **Reasoning.** A caller can set `include_reasoning` to receive the model's reasoning as separate `reasoning` events. It is never parsed and never part of the answer, and it can come from an attempt that fallback later discards.
  - On Groq the setting is free: gpt-oss reasons at `reasoning_effort: low` either way, and those tokens are billed either way, so we only choose whether to *receive* them.
  - On the local Qwen model the setting turns thinking on. Measured on this laptop, that changed one request from about 4 s to about 46 s and added about 1,200 completion tokens. That's why it's off by default in the API, and the console warns about it.
- **Online/offline labels.** Each backend is labelled online or offline from a 30 s probe (`GET {baseUrl}/models`) combined with the circuit breaker. Backends that aren't configured on a host are still listed, as offline with a reason. On the cloud deployment the local model shows as *offline: runs on a local machine*. The probe only feeds the label; routing still relies on the breaker and fallback.

## 3. Routing

**Backends.** I chose these for the constraints given: no keys are provided, and at least one real model must serve requests.

| id | tier | model | price in/out per 1M tokens | why |
|---|---|---|---|---|
| `groq-fast` | fast | `openai/gpt-oss-20b` (Groq free tier) | $0.075 / $0.30 | Cheap, about 0.6 s to first token. Groq moved its Llama models to enterprise-only, so gpt-oss is the self-serve option. |
| `groq-strong` | strong | `openai/gpt-oss-120b` (Groq) | $0.15 / $0.60 | Larger model, twice the price |
| `local-qwen3.5-4b` | local | Qwen3.5-4B, 4-bit, on Apple MLX (`mlx_lm.server`) | $0 marginal | Private and offline. Only available when running locally. Called `local-qwen` in the eval runs before 2026-11-12. |
| `mock` | degraded | extractive: streams the top KB answer verbatim | $0 | Always available and grounded. Configurable latency and failure. |

All prices are in `apps/gateway/src/main/config.ts` and are list prices at build time. The local model's cost is recorded as $0 marginal; electricity and hardware are not modelled.

**Rules,** in priority order. Each decision is stored as `{rule, reason, chain, signals}` and shown in the console.

1. **Plan entitlement.** Only backends whose tier is in the tenant's plan are candidates.
2. **Explicit hint.** The caller can pin a tier or backend. The rest of the default order stays as fallback.
3. **Auto.** Default to the fast tier. Escalate to the strong tier when the query is complex: `assessComplexity` (`entities/routing/complexity.ts`) adds up weighted signals, and the router escalates at a score of 0.5 (`ROUTE_COMPLEXITY_THRESHOLD`).

   | signal | fires when | weight |
   |---|---|---|
   | `long_query` | the newest user turn is over 60 estimated tokens | 0.5 |
   | `medium_query` | over 30 | 0.15 |
   | `ambiguous_intent` | support: the top intent holds under 60% of the score-weighted vote among the top 8 hits | 0.5 |
   | `multi_question` | 2+ question marks, or 2+ different wh-questions | 0.25 |
   | `reasoning` | compare, explain, trade-offs, step by step, recommend… | 0.2 / 0.35 / 0.5 for 1 / 2 / 3+ cues |
   | `multi_step` | a numbered or bulleted list, or "first … then …" | 0.2 |
   | `constraints` | 2+ output constraints ("at most", "as JSON"…) | 0.15 |
   | `code` | a code block or code-like syntax | 0.4 |
   | `math` | arithmetic or "how much in total" | 0.15 |
   | `long_conversation` | chat: 6+ messages | 0.1 |

   The two original rules (long message, ambiguous retrieval) still escalate on their own. The softer signals escalate only in combination: "why was I charged twice?" scores 0.2 and stays fast, while "Compare the standard and express shipping options, explain the trade-offs and recommend one" scores 0.5 and starts on the strong tier. It's a deterministic heuristic, not a classifier model: it costs nothing, adds no latency, and a stored decision can be replayed exactly. The score and every signal that fired are stored with the route and shown in the playground's Routing tab.

   **Measured** (`npm run routing-eval`, no model calls): on the 43 eval, hard-case and out-of-domain messages the route is unchanged from the old two-rule router (5 of 43 start on strong under both). Those sets are short templated support questions, so the eval numbers in §5 still hold. The analyzer only changes routing for phrasing those sets don't contain: comparisons, multi-part requests, code and calculations.

   **Seen live (2026-11-11):** the comparison example above escalated correctly, but `groq-strong` (gpt-oss-120b) returned an empty answer under prompt v3 in 3 of 3 direct tries. It spent about 240 tokens and sent no content, so the header check rejected it as `unusable_output` and the request fell back to `groq-fast`. Simple support questions pinned to `strong` were answered normally. Groq's rate limit stopped a larger measurement, so the rate is unknown. The fallback did its job, but on this prompt escalation costs about 1 s and the strong model's tokens for nothing. Next: measure it with `--delay`, then try `reasoning_effort: medium` for the strong tier.

   The rule names are `auto_default_fast`, `auto_escalate_strong`, `auto_escalate_denied_by_plan` and `auto_escalate_unavailable`.

   **Two more auto modes,** picked with the model name. The heuristic guesses from wording before any model runs, so I added one mode that reads meaning and one that looks at evidence:

   | mode | decides | from | extra cost | rules |
   |---|---|---|---|---|
   | `auto` | before any call | the weighted signals above | none | `auto_*` |
   | `auto-smart` | after admission, before the answer | a classification call on the fast model: `{"label":"simple"\|"complex","confidence","why"}` | one call, ~250 tokens, ~0.5–1 s | `smart_default_fast`, `smart_escalate_strong`, `smart_fallback_heuristic`… |
   | `auto-cascade` | at the fast model's header, before commit | what the fast model itself reported | the fast attempt, on escalated requests only | `cascade_start_fast`, attempt outcome `escalated` |

   - **auto-smart** (`entities/routing/classifier.ts`, `use-cases/router.ts`). The classifier is a model call, so it runs after quota admission. It is metered as attempt 0 with outcome `classified`, and the tenant pays for its tokens. The message goes in fenced as data. Ambiguous retrieval still escalates on its own, because the classifier can't see it. If the call fails, times out (2.5 s), returns something unparseable or is less than 0.6 confident, the heuristic decides and the reason says so. A classifier timeout doesn't count against the breaker, so it can't take the fast tier out of the answer chain. It is skipped when the plan has no strong tier, and for messages the scope gate refuses.
   - **auto-cascade** (`entities/routing/cascade.ts`, support only). Start on fast. The support header is validated before any answer text is sent, so the cascade can drop the fast attempt at that point without breaking the one-commit-point rule. It escalates only on doubt a stronger model can remove: the fast model said `unknown`, rated itself below 0.7, or disagreed with retrieval and would be refused. It never escalates when even a perfect answer (retrieval's top intent, self-confidence 1) would still fall below the refuse threshold. An escalation is not a failure: it doesn't trip the breaker or count as fallback. Chat has no header, so `auto-cascade` on chat is routed by the heuristic and the reason says so.

   **Measured live** (EVALUATION run 7: two runs of 17 support messages per mode, no judge; run 8 compares the classifier prompts). After fixing a flaw the first run exposed in each mode:

   | mode | success / refused | served by strong | cost / 1k req | latency p50 |
   |---|---|---|---|---|
   | `auto` | 11 / 6 | 3 | $0.136 | 662 ms |
   | `auto-smart` | 10 / 7 | 5 | $0.185 | 1100 ms |
   | `auto-cascade` | 11 / 6 | 7 | $0.194 | 849 ms |

   On this support task **neither new mode changed outcomes beyond run-to-run noise, and both cost more**. The six refusals are multi-intent or non-English messages. Retrieval can't settle on one intent for them, and the confidence formula is 80% retrieval, so the strong model refused them too (the cascade rescued 0 of 6). The bigger lever for those messages is multi-intent handling, not routing. The new modes earn their keep elsewhere. `auto-smart` caught a hard question with no cue words that the heuristic kept on fast, and after the v2 prompt it escalated none of the 30 held-out FAQ cases; that matters on open-ended chat traffic. `auto-cascade` is a cheap second opinion before a hand-off. `auto` stays the default.
4. **Fallback order:** remaining real tiers, then local, then degraded (extractive).

**Why default to fast?** The eval in §5 answers this with numbers. On held-out cases the 120b model is no more accurate than the 20b (100% vs 100% intent) and scarcely better on judged quality (4.53 vs 4.47). It costs twice as much. On this task the KB answer does most of the work, so the big model is worth paying for only when the inputs are hard. The escalation rule targets exactly those inputs.

**Fallback seen in the wild.** During the eval, Groq slowed down. On case `eval-24`, `groq-fast` hit its 6 s first-token timeout and then `groq-strong` hit its 8 s one. The request was served by `local-qwen`, and all three attempts are recorded in the `attempts` table. It cost 14 s of waiting, which exposes a weakness: both Groq backends share one provider, so their failures are correlated (see §7).

Fallback can also be demonstrated on demand. On the Backends page, set a backend's chaos mode to `error` (returns 503), `hang` (no first token), or `garbage` (unparseable output). The live deployment was smoke-tested with `hang` (served by `groq-strong` after a 6 s timeout) and `garbage` (unusable output, so the request moved on to the next backend). `error` is covered by the tests.

## 4. Support assistant

**Data split** (seeded, `tools/eval/prepare-data.ts`):
- KB: 80 rows per intent, 2,160 entries
- Eval: 30 held-out cases, one per intent plus 3 extra
- 5 out-of-domain prompts
- 1,350 more held-out rows for the cheap retrieval check

No eval question exactly duplicates a KB question. Bitext is template-generated, though, so close paraphrases of eval questions do exist in the KB. This makes the in-domain numbers optimistic, and it is why the hard-case probe below exists.

**Retrieval: BM25, not embeddings.** Bitext questions are short and lexically regular, so a lexical ranker is strong here. It is deterministic, adds no second model or provider to the request path, and is fast: the index builds in 3 ms and a query takes 0.14 ms.

| on 1,350 held-out rows, no LLM | result |
|---|---|
| kNN intent accuracy (score-weighted top-8 vote) | **94.7%** |
| recall@8 (correct intent anywhere in the top 8) | **99.6%** |

A typo-correction step maps unseen query terms to the most frequent KB term within edit distance 1, or 2 for words of 8+ characters. Before I added it, "i forgot my **pasword**" was refused: the unseen term carried the maximum IDF weight and dragged coverage down. The fix cut wrongly gated in-domain rows from 1.3% to 0.4%.

**Output contract.** The model must start with `{"intent": "...", "confidence": 0..1}`, then a line `###`, then the answer. The parser buffers until the header is complete and validates it:
- it must be JSON (code fences and `<think>` blocks are tolerated)
- the label must be one of the 27 intents or `unknown`
- a confidence given as 85 instead of 0.85 is normalised

Only then does any text stream. A malformed header, an unknown label or an empty answer counts as `unusable_output`, and the request moves on to the next backend.

**Confidence.** The confidence score combines three signals:

`0.45 × retrieval vote for the model's intent + 0.35 × lexical coverage + 0.20 × model self-report`

The model's self-reported confidence gets the smallest weight on purpose: it is the least reliable signal. The retrieval vote is used *for the intent the model chose*, so when the model disagrees with retrieval the score drops automatically.

**Refusal.**
- Out of scope, gate: coverage below 0.3 on a short message (6 content terms or fewer). No model call.
- Out of scope, model: the model labels the message `unknown`.
- Low confidence: the score is below 0.5. The customer gets a hand-off message instead of a guess. The model stream is aborted, so the remaining tokens are never paid for.

**Template placeholders.** Bitext answers are templates: 76 distinct slots such as `{{Order Number}}`, `{{Customer Support Phone Number}}` and `{{Online Order Interaction}}`. Streaming them to a customer as raw text is unacceptable. Asking the model to "fill them in" would invite it to invent phone numbers and URLs. So the work is split:
- **The model:** keeps placeholders. Prompt v3 lists exactly which ones have real values for this request; anything else it writes in plain words.
- **The gateway:** fills them deterministically while streaming (`entities/support/placeholders.ts`), from four sources in priority order:
  1. the customer's message (order, invoice and tracking ids, amounts, plan names)
  2. the tenant's **company profile**, a new `tenants.profile` column with phone, hours, email, URLs and shipping times
  3. default UI labels (`{{Online Order Interaction}}` → "Orders")
  4. a natural fallback phrase ("your order number", or "on file" when the sentence already names the id)

The renderer handles placeholders split across stream chunks, model-shortened names (`{{Support Phone Number}}`), a currency sign directly before an amount slot, and duplicated determiners. Every filled slot is reported in a `placeholders_rendered` step, with its value and source, and shown in the console.

Measured on groq-fast, 30 held-out cases ([`2026-11-10T08-11-44`](../tools/eval/results/2026-11-10T08-11-44.md)):

| | v2, raw | v3, rendered |
|---|---|---|
| answers showing raw `{{…}}` to the customer | **15/30** | **0/30** |
| intent accuracy / OOD refused | 100% / 5/5 | 100% / 5/5 |
| LLM judge, 1–5 | 4.60 | 4.50 |
| tokens per call / cost per 1k requests | 1,080 / $0.093 | 1,162 / $0.099 |

- **Leaks:** across three runs, raw placeholders appeared in 15–16 of 30 v2 answers and in **0** v3 answers.
- **Judge score:** about 0.1 lower for v3 in both clean runs (4.53 vs 4.40, then 4.60 vs 4.50).
  - The judge's reasons for the low v3 scores mostly cite tone or missing follow-up questions, not the rendering.
  - Two reasons pointed at genuine rendering artifacts: "the order number your order number", and an empty gap where an unknown name went. Both were fixed, along with a currency-sign bug the same check uncovered, and covered by tests.
  - The reference answers are themselves templates, so a judge comparing against them may slightly favour template-like text. I can't rule out a small real cost. I accept it: the alternative is showing customers raw template syntax.
- **Token cost:** v3 costs about 7% more tokens because of the slot list in the prompt.

A third run ([`08-35-26`](../tools/eval/results/2026-11-10T08-35-26.md)) hit Groq's free-tier limit of 8k tokens per minute, which is shared by everything using the key. The breaker and fallback served 59 of 60 in-domain requests, through groq-strong, local-qwen and the extractive backend, with **0 errors**. That makes it a good resilience result. The two configurations were served by different models, though, so I left it out of the quality comparison.

## 5. Evaluation

**Method.** `tools/eval/eval.ts` drives the real HTTP gateway (auth → quota → routing → streaming → metering) once for each configuration. It runs sequentially because of Groq's free-tier limit of 8k tokens per minute. For each configuration it measures:
- **Intent accuracy** against the Bitext label.
- **Answer quality, two ways:**
  - ROUGE-L F1 against the Bitext reference answer: cheap and deterministic, but it only measures wording overlap.
  - An LLM judge (gpt-oss-120b, called through the gateway) scoring 1–5 against the reference: "5 = correct and complete, no invented facts".
- **Latency:** total and time to first token, measured by the client.
- **Tokens and cost** as metered by the gateway.

Results are from [`2026-11-10T04-32-12.md`](../tools/eval/results/2026-11-10T04-32-12.md): 30 held-out in-domain cases and 5 out-of-domain cases.

| | groq-fast · v2 | groq-strong · v2 | groq-fast · v1 | local-qwen · v2 |
|---|---|---|---|---|
| intent accuracy | **100%** | **100%** | 96.7% | **100%** |
| false refusals (in-domain) | 0/30 | 0/30 | 0/30 | 0/30 |
| out-of-domain refused | 5/5 | 5/5 | 5/5 | 5/5 |
| LLM judge, 1–5 | 4.47 | **4.53** | 4.50 | 4.43 |
| ROUGE-L F1 | 0.31 | 0.31 | 0.30 | 0.31 |
| latency p50 / p95 | 0.74 / 2.11 s | 0.79 / 1.41 s | 0.74 / 2.16 s | 5.27 / 9.23 s |
| time to first token p50 / p95 | 0.61 / 2.01 s | 0.65 / 1.11 s | 0.58 / 2.08 s | 3.34 / 5.18 s |
| tokens per call | 1,092 | 1,094 | **744** | 1,057 |
| est. cost per 1k requests | $0.092 | $0.185 | **$0.078** | $0 |

The retrieval-only baseline (the `mock` backend) reached 96.7% intent accuracy at about 0.05 s to first token (run [`04-15-13`](../tools/eval/results/2026-11-10T04-15-13.md)).

**What the numbers say, and what they don't:**
- **Model comparison (fast vs strong).** Same accuracy and roughly the same judged quality, at half the price. This is the evidence behind defaulting to fast. The strong model had a tighter p95 latency on this run, but n=30 can't separate provider noise from the model.
- **Prompt comparison (v1 vs v2).** v1 is 32% cheaper. It made one intent error (`get_invoice` labelled `check_invoice` on a typo'd message) and had the same judged quality, within noise. I kept v2 as the default for reasons the in-domain set doesn't measure: explicit grounding rules ("don't invent policies or phone numbers"), placeholder preservation, and the `unknown` escape that the hard-case probe relies on. A 0.03 difference in judge score on n=30 is not a result, and I'm not reading it as one.
- **The in-domain set is close to saturated.** Every real model scores 100%, and BM25 alone scores 96.7%. Templated data makes intent detection easy. So the meaningful differences are cost and latency, and behaviour on hard inputs, which comes next.

**Hard-case probe** (`tools/eval/probe.ts`, [`probe-groq-fast.md`](../tools/eval/results/probe-groq-fast.md)). Eight inputs built to break things: off-topic text that slips past the lexical gate, a prompt injection inside a real request, multi-intent, vague, Indonesian, typo-heavy and angry messages.

The first run scored **6/8**. Two in-domain messages, the angry customer and the cancel-plus-injection, were wrongly refused at the lexical gate: extra words dilute coverage. I tried an absolute "matched evidence" signal first. It couldn't separate them either: the weather question matches as much as the angry customer does. So I changed the policy instead. The gate now applies only to short messages (6 content terms or fewer), and longer messages always go to the model, whose `unknown` label and confidence check handle out-of-scope cases. After the change:
- the probe scores **8/8**
- the out-of-domain set still scores 5/5 (the injection-only prompt now reaches the model, which labels it `unknown`)
- wrongly gated in-domain rows are unchanged at 0.4%

On the cancel-plus-injection message, the model answered the cancellation and ignored the injection without leaking the prompt.

Multi-intent ("charged twice … payment methods … refund?"), vague ("it doesn't work") and Indonesian messages are **refused with a hand-off** rather than answered. That's deliberate: the assistant prefers "I'm not sure, here's a human" to a confident wrong answer. It also points to the next feature to build (see §7).

**Token accounting.** Each row records `usage_source`: `provider` (from the provider's usage report), `estimated` (mock backend, aborted streams), or `none` (the provider rejected the call). I checked the chars/4 estimator against provider counts on the 119 eval calls. It reads **6–17% high** (mean 1.06–1.17×). For quota pre-authorisation that is the safe direction. It means estimated rows overstate cost a little, and they are labelled as estimates.

**Tests.** There are 160 vitest tests, all without network: 135 in the gateway, on scripted fake backends and in-memory SQLite, and 25 in the console. They cover:
- the support header parser, retrieval, the routing rules and query complexity
- fallback on error, first-token timeout and unusable output, and no fallback after commit
- the circuit breaker
- quota reservation, 429, and the fail-closed 503 when the database is gone
- API key auth, validation, the 403 plan check, and refusals
- the auto-smart and auto-cascade router modes, as pure rules and over HTTP
- context windows: auto skips a model too small for the request, a pinned one returns `context_length_exceeded` before admission, and `max_tokens` counts
- the OpenAI-compatible endpoints, through the real `openai` SDK
- reasoning streamed separately and only when asked for, and offline backends labelled
- placeholder extraction, rendering across chunk boundaries, and raw mode
- console sign-in, sessions, CSRF, role permissions, tenant isolation, API key management and error hygiene
- the PII detectors, the guardrail on the request path, and the governance API
- the error catalog against docs/ERRORS.md
- dashboard metrics bucketing and percentiles, the attempt trail, and the eval-run listing
- the dependency rule of the clean architecture, in both apps

## 6. Trade-offs I accepted

- **SQLite on Render's free tier is ephemeral.** Metering survives requests but resets on redeploy or spin-down. A single file with real transactions made the quota logic simple and correct. For production I would use Postgres: the SQL is portable, and the reservation becomes `SELECT … FOR UPDATE`.
- **Fallback only before the commit point.** A model that dies halfway through an answer produces a `partial` outcome, not a seamless retry. Splicing two models' text mid-sentence is worse than an honest error.
- **Refusals abort the stream.** That saves money, but their token counts are estimated.
- **A failed attempt's prompt tokens are counted against quota.** Real spend is real spend. So a request admitted near the quota limit can overshoot by the prompt tokens of its failed attempts. Admission is still strict for the next request.
- **Demo mode prints the demo passwords on the sign-in page.** With `DEMO_MODE=true`, the four seeded console accounts and their passwords are listed so reviewers can try every role, and the seeded tenant keys are public demo values. Keys and the admin token never reach the browser either way. Demo mode must be off in production, where one operator account is created from `BOOTSTRAP_OPERATOR_*` env vars.
- **The LLM judge is a model from the same family** as two of the candidates. It's useful for relative comparison, not as ground truth. ROUGE-L is reported next to it as a judge-free number.

## 7. What I cut, and what I'd do next

**Cut on purpose:**
- Multi-turn conversation memory. The support endpoint is single-turn.
- Embeddings and hybrid retrieval: BM25 measured 99.6% recall@8.
- Rate limiting per second on the API. Quota is monthly; burst limits belong in the edge proxy. (Console sign-in does have a failed-attempt limit.)
- Tenant and user management. Tenants and console users are seeded. The console can list members and manage API keys (create, scope, expire, revoke), but it can't create tenants, invite users or reset passwords.
- SSO and MFA for the console. It has email and password sign-in with sessions, CSRF and four roles.
- Persistent production database. Kept to SQLite for the timebox; see §6.

**Next:**
- A *provider-level* circuit breaker, so that one Groq outage costs one timeout instead of two.
- Splitting multi-intent messages and answering each part, instead of handing off. The router-modes run (§3) shows this matters more than routing: the strong model refused the same multi-intent messages the fast one did.
- A judged quality eval across the three router modes (`npm run eval -- --configs auto:v3,auto-smart:v3,auto-cascade:v3 --judge groq-strong`). The live run in §3 measured routing, cost and outcome, not answer quality.
- Language detection, with a translated query for retrieval (so Indonesian messages are answered, not refused).
- A harder, paraphrased eval set, so prompt and model differences show up in accuracy and not only in cost.
- Retrieval upgrades for the measured gaps (Indonesian, paraphrases, multi-intent): hybrid BM25 + multilingual dense retrieval with a reranker, uncertainty-aware fusion, and multi-intent decomposition. The recent papers behind each are in the README, "Next development: improving retrieval".
