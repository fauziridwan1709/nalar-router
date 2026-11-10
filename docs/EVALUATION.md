# Evaluation results

This page lists every evaluation that was run, with its headline numbers and a link to the raw output. The raw files live in [`tools/eval/results/`](../tools/eval/results/), and the same runs are charted on the console's **Evaluations** page. How each eval works and what the numbers mean is explained in [REPORT.md §5](REPORT.md#5-evaluation).

![Evaluations page](assets/console-evaluations.png)

## Data

| set | size | source | used for |
|---|---|---|---|
| Knowledge base | 2,160 | Bitext, 80 per intent | retrieval and grounding |
| Held-out eval | 30 | Bitext, one per intent plus 3, never in the KB | the end-to-end eval below |
| Retrieval holdout | 1,350 | Bitext, 50 per intent | LLM-free retrieval accuracy |
| Out-of-domain | 5 | hand-written | refusal checks |
| Hard cases | 8 | hand-written: injection, angry, multi-intent, vague, Indonesian, typos | behavioural probe |

The split is seeded and reproducible: `npm run prepare-data`.

## Runs

### 1. Retrieval only, no LLM ([`retrieval-eval.txt`](../tools/eval/results/retrieval-eval.txt))

| metric | value |
|---|---|
| kNN intent accuracy (1,350 held-out rows) | **94.7%** |
| recall@8 (right intent anywhere in the top 8) | **99.6%** |
| in-domain wrongly refused by the coverage check | 0.4% |
| query latency | 0.14 ms |

### 2. Model and prompt comparison ([`2026-11-10T04-32-12`](../tools/eval/results/2026-11-10T04-32-12.md))

The LLM judge here is gpt-oss-120b.

| config | intent | judge (1–5) | p50 latency | cost per 1k |
|---|---|---|---|---|
| groq-fast, prompt v2 | 100% | 4.47 | 0.74 s | $0.092 |
| groq-strong, prompt v2 | 100% | 4.53 | 0.79 s | $0.185 |
| groq-fast, prompt v1 | 96.7% | 4.50 | 0.74 s | $0.078 |
| local-qwen (MLX), prompt v2 | 100% | 4.43 | 5.27 s | $0 |

The strong model is no more accurate here and costs twice as much. That is why the router defaults to fast and escalates only on hard inputs. During this run one request hit a real Groq slowdown: both Groq models timed out, and local Qwen answered.

### 3. Local model, prompt v1 vs v2 ([`2026-11-10T04-15-13`](../tools/eval/results/2026-11-10T04-15-13.md))

This run has no judge. It also includes the retrieval-only `mock` baseline:
- **Intent accuracy:** local Qwen scored 100% with both prompts; the extractive mock scored 96.7%.
- **Speed:** v1 was faster for local Qwen, 6.7 s vs 8.3 s p50.

### 4. Placeholder rendering ([`2026-11-10T08-11-44`](../tools/eval/results/2026-11-10T08-11-44.md))

| config | answers showing raw `{{…}}` | intent | judge | cost per 1k |
|---|---|---|---|---|
| groq-fast, v2, raw | 15/30 | 100% | 4.60 | $0.093 |
| groq-fast, v3, rendered | **0/30** | 100% | 4.50 | $0.099 |

The judge scores v3 about 0.1 lower, consistently across runs. The caveats are in the report.

### 5. Placeholder rendering, rate-limited re-run ([`2026-11-10T08-35-26`](../tools/eval/results/2026-11-10T08-35-26.md))

This re-run hit Groq's free-tier limit of 8k tokens per minute. Fallback served **59 of 60** in-domain requests with **0 errors**, using groq-strong, local-qwen and the extractive backend. Since different models answered each configuration, this run counts as a resilience result, not a quality comparison.

### 6. Hard-case probe ([`probe-groq-fast.md`](../tools/eval/results/probe-groq-fast.md))

The probe scored **8/8** after one fix, and the probe itself found the problem. On the first run, long in-domain messages were wrongly refused by the coverage check, because the extra words diluted coverage.

## Reproduce

```bash
npm run retrieval-eval
npm run eval -- --base http://localhost:3000 --configs groq-fast:v2,groq-strong:v2 --judge groq-strong --delay 17000
npm run eval -- --base http://localhost:3000 --configs groq-fast:v2:raw,groq-fast:v3 --judge groq-strong --delay 17000
npm run probe -w @nalar-router/eval -- --base http://localhost:3000 --model groq-fast
```

`--delay` keeps the run under Groq's free tier of 8k tokens per minute. That limit is shared by every caller on the key, including the deployed instance.
