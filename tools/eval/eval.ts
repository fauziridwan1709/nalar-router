/**
 * End-to-end evaluation through the real gateway (auth → quota → routing → model → metering).
 *
 *   npm run eval -- --base http://localhost:3000 \
 *       --configs groq-fast:v2,groq-strong:v2 --judge groq-strong
 *
 * Each config is <model-or-tier>:<prompt-version>[:raw]. ":raw" turns off placeholder rendering. For every config we run the 30
 * held-out cases + 5 out-of-domain prompts sequentially (free-tier rate limits) and report:
 *   - intent accuracy (all cases; refusals count as wrong) and on answered cases
 *   - false-refusal rate (in-domain) and correct-refusal rate (out-of-domain)
 *   - answer quality: ROUGE-L F1 vs the Bitext reference answer, and (optional) an
 *     LLM-judge score 1–5 using a model served by the same gateway
 *   - latency (client-measured total and time-to-first-token, p50/p95)
 *   - tokens and estimated cost as metered by the gateway
 * Results: eval/results/<stamp>.json + eval/results/<stamp>.md
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, "../../data");
const RESULTS = resolve(HERE, "results");

const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((acc, a, i, all) => {
    if (a.startsWith("--"))
      acc.push([a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "true" : all[i + 1]]);
    return acc;
  }, []),
);
const BASE = args.base ?? "http://localhost:3000";
const KEY = args.key ?? process.env.EVAL_API_KEY ?? "sk-eval-demo-e7a1";
const CONFIGS = (args.configs ?? "auto:v1,auto:v2").split(",").map((c) => {
  // <model>:<prompt>[:raw]  (raw = stream the model text without placeholder rendering)
  const [model, prompt, render] = c.split(":");
  return { name: c, model, prompt: prompt ?? "v3", placeholders: render === "raw" ? "raw" : "fill" };
});
const JUDGE = args.judge && args.judge !== "none" ? args.judge : null;
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const SKIP_OOD = args["no-ood"] === "true";
const DELAY_MS = Number(args.delay ?? 0); // spacing between calls for strict free-tier RPM limits

interface Case {
  id: string;
  message: string;
  expectedIntent: string | null;
  referenceAnswer?: string;
  shouldRefuse?: boolean;
}
const inDomain: Case[] = JSON.parse(readFileSync(resolve(DATA, "eval.json"), "utf8")).slice(0, LIMIT);
const ood: Case[] = SKIP_OOD ? [] : JSON.parse(readFileSync(resolve(DATA, "eval-ood.json"), "utf8"));

// ---------- metrics ----------
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/\{\{[^}]*\}\}/g, " placeholder ")
    .match(/[a-z0-9]+/g) ?? [];
export function rougeL(cand: string, ref: string) {
  const a = words(cand);
  const b = words(ref);
  if (!a.length || !b.length) return 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const lcs = dp[b.length];
  const p = lcs / a.length;
  const r = lcs / b.length;
  return p + r ? (2 * p * r) / (p + r) : 0;
}
const pct = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- client ----------
async function ask(message: string, model: string, prompt: string, placeholders = "fill") {
  const t0 = performance.now();
  let ttft: number | null = null;
  const res = await fetch(`${BASE}/v1/support/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ message, model, prompt_version: prompt, placeholders, stream: true }),
  });
  if (!res.ok) return { httpError: `${res.status} ${await res.text()}` } as any;
  const out: any = { answer: "", attempts: [] };
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!ev || !data) continue;
      const d = JSON.parse(data);
      if (ev === "token") {
        if (ttft === null) ttft = performance.now() - t0;
        out.answer += d.text;
      } else if (ev === "attempt" && d.status !== "started") out.attempts.push(d);
      else out[ev] = d;
    }
  }
  out.clientLatencyMs = performance.now() - t0;
  out.clientTtftMs = ttft;
  return out;
}

async function judge(question: string, reference: string, answer: string) {
  const prompt = `You are grading a customer-support answer against a reference answer from the company's knowledge base.
Score 1-5:
5 = correct and complete, consistent with the reference, no invented facts
4 = correct, minor omissions
3 = partially correct or vague
2 = mostly wrong / unhelpful
1 = wrong, harmful, or invents policies

The reference is a template: placeholders like {{Order Number}} or {{Customer Support Phone Number}} stand for real values. A candidate that shows concrete values or plain-language phrases in their place is correct; do not penalise that. A candidate that still shows raw {{...}} placeholders to the customer is worse (at most 4).

Customer: ${question}
Reference answer: ${reference}
Candidate answer: ${answer}

Reply with JSON only: {"score": <1-5>, "reason": "<one sentence>"}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: JUDGE,
        stream: false,
        temperature: 0,
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const j: any = await res.json().catch(() => ({}));
    const text: string = j?.choices?.[0]?.message?.content ?? "";
    const m = /"score"\s*:\s*([1-5])/.exec(text);
    if (m)
      return {
        score: Number(m[1]),
        reason: /"reason"\s*:\s*"([^"]*)"/.exec(text)?.[1] ?? "",
        costUsd: j?.x_router?.costUsd ?? 0,
      };
    await sleep(1000);
  }
  return { score: null, reason: "judge output unparseable", costUsd: 0 };
}

// ---------- run ----------
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const report: any = {
  stamp,
  base: BASE,
  judge: JUDGE,
  n: { inDomain: inDomain.length, ood: ood.length },
  configs: [] as any[],
};

for (const c of CONFIGS) {
  console.log(`\n=== ${c.name} ===`);
  const rows: any[] = [];
  for (const k of [...inDomain, ...ood]) {
    const r = await ask(k.message, c.model, c.prompt, c.placeholders);
    const refused = !!r.refusal;
    const predicted = r.intent?.intent ?? null;
    const row: any = {
      id: k.id,
      message: k.message,
      expectedIntent: k.expectedIntent,
      predicted,
      refused,
      refusalReason: r.refusal?.reason ?? null,
      correctIntent: k.expectedIntent ? predicted === k.expectedIntent : null,
      outcome: r.done?.outcome ?? r.httpError ?? "no_done",
      backend: r.done?.backend ?? null,
      fallback: r.done?.fallbackUsed ?? false,
      confidence: r.done?.confidence ?? null,
      latencyMs: r.clientLatencyMs,
      ttftMs: r.clientTtftMs,
      serverLatencyMs: r.done?.latencyMs ?? null,
      tokens: r.done?.usage?.totalTokens ?? 0,
      promptTokens: r.done?.usage?.promptTokens ?? 0,
      completionTokens: r.done?.usage?.completionTokens ?? 0,
      usageSource: r.done?.usage?.source ?? null,
      costUsd: r.done?.costUsd ?? 0,
      answer: r.answer,
      leakedPlaceholders: (r.answer.match(/\{\{[^}]*\}\}/g) ?? []).length,
      rougeL: k.referenceAnswer && !refused && r.answer ? rougeL(r.answer, k.referenceAnswer) : null,
    };
    if (JUDGE && k.referenceAnswer && !refused && r.answer) {
      const j = await judge(k.message, k.referenceAnswer, r.answer);
      row.judgeScore = j.score;
      row.judgeReason = j.reason;
      row.judgeCostUsd = j.costUsd;
    }
    rows.push(row);
    const tag = k.expectedIntent ? (row.correctIntent ? "✓" : refused ? "R" : "✗") : refused ? "R✓" : "✗(answered OOD)";
    console.log(
      `${k.id.padEnd(8)} ${tag.padEnd(4)} ${String(predicted ?? "-").padEnd(26)} ${row.backend ?? "-"}${row.fallback ? "(fb)" : ""} ${Math.round(row.latencyMs)}ms ${row.tokens}tok${row.judgeScore ? ` judge=${row.judgeScore}` : ""}${row.rougeL != null ? ` rL=${row.rougeL.toFixed(2)}` : ""}`,
    );
    if (DELAY_MS) await sleep(DELAY_MS);
  }

  const ind = rows.filter((r) => r.expectedIntent);
  const oodRows = rows.filter((r) => !r.expectedIntent);
  const answered = ind.filter((r) => !r.refused && r.outcome === "success");
  const modelCalls = rows.filter((r) => r.tokens > 0);
  const summary = {
    config: c.name,
    intentAccuracy: ind.filter((r) => r.correctIntent).length / ind.length,
    intentAccuracyAnswered: answered.length ? answered.filter((r) => r.correctIntent).length / answered.length : null,
    answeredRate: answered.length / ind.length,
    falseRefusals: ind.filter((r) => r.refused).length,
    oodCorrectlyRefused: oodRows.filter((r) => r.refused).length,
    oodTotal: oodRows.length,
    errors: rows.filter((r) => !["success", "refused_out_of_scope", "refused_low_confidence"].includes(r.outcome))
      .length,
    fallbacks: rows.filter((r) => r.fallback).length,
    answersWithRawPlaceholders: answered.filter((r) => r.leakedPlaceholders > 0).length,
    rougeLMean: mean(answered.map((r) => r.rougeL).filter((x) => x != null)),
    judgeMean: mean(answered.map((r) => r.judgeScore).filter((x) => x != null)),
    judgeN: answered.filter((r) => r.judgeScore != null).length,
    latencyP50: pct(
      ind.map((r) => r.latencyMs),
      0.5,
    ),
    latencyP95: pct(
      ind.map((r) => r.latencyMs),
      0.95,
    ),
    ttftP50: pct(
      ind.map((r) => r.ttftMs).filter((x) => x != null),
      0.5,
    ),
    ttftP95: pct(
      ind.map((r) => r.ttftMs).filter((x) => x != null),
      0.95,
    ),
    tokensTotal: rows.reduce((n, r) => n + r.tokens, 0),
    tokensPerModelCall: modelCalls.length
      ? Math.round(modelCalls.reduce((n, r) => n + r.tokens, 0) / modelCalls.length)
      : 0,
    costTotalUsd: rows.reduce((n, r) => n + r.costUsd, 0),
    costPer1kRequestsUsd: (rows.reduce((n, r) => n + r.costUsd, 0) / rows.length) * 1000,
    backends: rows.reduce(
      (m: Record<string, number>, r) => ((m[r.backend ?? "none"] = (m[r.backend ?? "none"] ?? 0) + 1), m),
      {},
    ),
    usageSources: rows.reduce(
      (m: Record<string, number>, r) => ((m[r.usageSource ?? "none"] = (m[r.usageSource ?? "none"] ?? 0) + 1), m),
      {},
    ),
  };
  report.configs.push({ ...summary, rows });
  console.log(JSON.stringify(summary, null, 2));
}

// ---------- write ----------
const f = (x: number | null, d = 2) => (x == null ? "–" : x.toFixed(d));
const ms = (x: number | null) => (x == null ? "–" : `${(x / 1000).toFixed(2)} s`);
const md = [
  `# Eval ${stamp}`,
  ``,
  `Gateway: \`${BASE}\` · ${inDomain.length} held-out in-domain cases + ${ood.length} out-of-domain · judge: ${JUDGE ?? "none"}`,
  ``,
  `| metric | ${report.configs.map((c: any) => `\`${c.config}\``).join(" | ")} |`,
  `|---|${report.configs.map(() => "---").join("|")}|`,
  ...[
    ["intent accuracy (all, refusal = wrong)", (c: any) => `${f(c.intentAccuracy * 100, 1)}%`],
    [
      "intent accuracy (answered only)",
      (c: any) => (c.intentAccuracyAnswered == null ? "–" : `${f(c.intentAccuracyAnswered * 100, 1)}%`),
    ],
    ["false refusals (in-domain)", (c: any) => `${c.falseRefusals}/${inDomain.length}`],
    ["OOD correctly refused", (c: any) => `${c.oodCorrectlyRefused}/${c.oodTotal}`],
    ["answer quality: ROUGE-L F1 (mean)", (c: any) => f(c.rougeLMean)],
    [
      "answer quality: LLM judge 1–5 (mean)",
      (c: any) => (c.judgeMean == null ? "–" : `${f(c.judgeMean)} (n=${c.judgeN})`),
    ],
    ["latency p50 / p95", (c: any) => `${ms(c.latencyP50)} / ${ms(c.latencyP95)}`],
    ["time to first token p50 / p95", (c: any) => `${ms(c.ttftP50)} / ${ms(c.ttftP95)}`],
    ["tokens per model call (mean)", (c: any) => String(c.tokensPerModelCall)],
    ["total est. cost (35 req)", (c: any) => `$${c.costTotalUsd.toFixed(5)}`],
    ["est. cost per 1k requests", (c: any) => `$${c.costPer1kRequestsUsd.toFixed(3)}`],
    [
      "answers showing raw {{placeholders}}",
      (c: any) => `${c.answersWithRawPlaceholders}/${c.answered ?? inDomain.length}`,
    ],
    ["errors / fallbacks", (c: any) => `${c.errors} / ${c.fallbacks}`],
    [
      "served by",
      (c: any) =>
        Object.entries(c.backends)
          .map(([k, v]) => `${k}:${v}`)
          .join(", "),
    ],
  ].map(([label, fn]: any) => `| ${label} | ${report.configs.map(fn).join(" | ")} |`),
  ``,
  `## Misclassified / refused in-domain cases`,
  ``,
  ...report.configs.flatMap((c: any) => [
    `**${c.config}**`,
    ``,
    ...c.rows
      .filter((r: any) => r.expectedIntent && !r.correctIntent)
      .map(
        (r: any) =>
          `- \`${r.id}\` "${r.message}" → expected \`${r.expectedIntent}\`, got \`${r.predicted ?? "-"}\`${r.refused ? ` (refused: ${r.refusalReason})` : ""}`,
      ),
    ``,
  ]),
].join("\n");

mkdirSync(RESULTS, { recursive: true });
writeFileSync(resolve(RESULTS, `${stamp}.json`), JSON.stringify(report, null, 2));
writeFileSync(resolve(RESULTS, `${stamp}.md`), md);
console.log(`\n${md}\n\nwritten tools/eval/results/${stamp}.{json,md}`);
