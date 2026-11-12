# auto-smart classifier prompt, v1 vs v2 (2026-11-12)

The classifier alone (no answer generation): `openai/gpt-oss-20b` on Groq, `reasoning_effort: low`, temperature 0, the message fenced as in `buildClassifierMessages`. 42 messages: the 30 held-out eval cases plus the 12 hard and example messages from the router-modes run.

Labels are mine, not a dataset's: 7 messages count as complex (hard-04 and ex-2, the same multi-part billing question; ex-3 comparison; ex-4 two ordered steps; ex-5 arithmetic; ex-6 refund missing and charged again; ex-7 two problems). Everything else, including all 30 eval cases, counts as simple.

| prompt | complex caught | simple escalated by mistake | unparseable | latency p50 |
|---|---|---|---|---|
| v1 | 5 / 7 | 4 / 35 | 0 | 461 ms |
| v2 (shipped) | 5 / 7 | 0 / 34 | 1 (hard-03, the prompt-injection message; the router fell back to the heuristic) | 621 ms |

## Disagreements with the labels

| prompt | id | label | classifier said | confidence | why |
|---|---|---|---|---|---|
| v1 | eval-04 | simple | complex | 0.85 | requires explanation and guidance |
| v1 | eval-05 | simple | complex | 0.85 | requires bill review and assistance |
| v1 | eval-10 | simple | complex | 0.9 | requires personalized support |
| v1 | hard-08 | simple | complex | 0.92 | multiple complaints, emotional tone |
| v1 | ex-5 | complex | simple | 0.99 | single arithmetic question |
| v1 | ex-6 | complex | simple | 0.95 | single refund inquiry |
| v2 | hard-03 | simple | unparseable |  |  |
| v2 | ex-2 | complex | simple | 0.95 | single refund request |
| v2 | ex-7 | complex | simple | 0.95 | single issue, no reasoning needed |

v2 labelled hard-04 complex and ex-2 simple although the text is identical, so at temperature 0 the verdict still varies between calls.
