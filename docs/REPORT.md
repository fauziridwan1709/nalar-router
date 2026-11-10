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

## 3. Routing

**Backends.** I chose these for the constraints given: no keys are provided, and at least one real model must serve requests.

| id | tier | model | price in/out per 1M tokens | why |
|---|---|---|---|---|
| `groq-fast` | fast | `openai/gpt-oss-20b` (Groq free tier) | $0.075 / $0.30 | Cheap, about 0.6 s to first token. Groq moved its Llama models to enterprise-only, so gpt-oss is the self-serve option. |
| `groq-strong` | strong | `openai/gpt-oss-120b` (Groq) | $0.15 / $0.60 | Larger model, twice the price |
| `local-qwen` | local | Qwen3.5-4B, 4-bit, on Apple MLX (`mlx_lm.server`) | $0 marginal | Private and offline. Only available when running locally. |
| `mock` | degraded | extractive: streams the top KB answer verbatim | $0 | Always available and grounded. Configurable latency and failure. |

All prices are in `config.ts` and are list prices at build time. The local model's cost is recorded as $0 marginal; electricity and hardware are not modelled.

**Rules,** in priority order. Each decision is stored as `{rule, reason, chain, signals}` and shown in the console.

1. **Plan entitlement.** Only backends whose tier is in the tenant's plan are candidates.
2. **Explicit hint.** The caller can pin a tier or backend. The rest of the default order stays as fallback.
3. **Auto.** Default to the fast tier. Escalate to the strong tier only when there is evidence the small model may struggle:
   - the message is long (more than 60 estimated tokens), or
   - retrieval is ambiguous: the top intent holds less than 60% of the score-weighted vote among the top 8 hits.

   The rule names are `auto_default_fast`, `auto_escalate_strong`, `auto_escalate_denied_by_plan` and `auto_escalate_unavailable`.
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

**Retrieval: BM25, not embeddings.** Bitext questions are short and lexically regular, so a lexical ranker is strong here. It is deterministic, adds no second model or provider to the request path, and is fast: the index builds in 3 ms and a query takes 0.12 ms.

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

**Tests.** There are 29 vitest tests on scripted fake backends, with no network. They cover:
- the parser
- retrieval
- the routing rules
- fallback on error, first-token timeout and unusable output
- no fallback after commit
- the circuit breaker
- quota reservation, 429, and the fail-closed 503 when the database is gone
- auth, validation, the 403 plan check
- refusals
- the OpenAI-compatible stream format

## 6. Trade-offs I accepted

- **SQLite on Render's free tier is ephemeral.** Metering survives requests but resets on redeploy or spin-down. A single file with real transactions made the quota logic simple and correct. For production I would use Postgres: the SQL is portable, and the reservation becomes `SELECT … FOR UPDATE`.
- **Fallback only before the commit point.** A model that dies halfway through an answer produces a `partial` outcome, not a seamless retry. Splicing two models' text mid-sentence is worse than an honest error.
- **Refusals abort the stream.** That saves money, but their token counts are estimated.
- **A failed attempt's prompt tokens are counted against quota.** Real spend is real spend. So a request admitted near the quota limit can overshoot by the prompt tokens of its failed attempts. Admission is still strict for the next request.
- **The demo keys and admin token are visible** to the console via `/api/demo-config` when `DEMO_MODE=true`. It's convenient for reviewers and must be off in production.
- **The LLM judge is a model from the same family** as two of the candidates. It's useful for relative comparison, not as ground truth. ROUGE-L is reported next to it as a judge-free number.

## 7. What I cut, and what I'd do next

**Cut on purpose:**
- Multi-turn conversation memory. The support endpoint is single-turn.
- Embeddings and hybrid retrieval: BM25 measured 99.6% recall@8.
- Rate limiting per second. Quota is monthly; burst limits belong in the edge proxy.
- Key rotation and a tenant admin UI. Tenants are seeded.
- Persistent production database. Kept to SQLite for the timebox; see §6.
- Auth on the console beyond demo mode.

**Next:**
- A *provider-level* circuit breaker, so that one Groq outage costs one timeout instead of two.
- Splitting multi-intent messages and answering each part, instead of handing off.
- Language detection, with a translated query for retrieval (so Indonesian messages are answered, not refused).
- A harder, paraphrased eval set, so prompt and model differences show up in accuracy and not only in cost.
