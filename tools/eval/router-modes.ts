/**
 * Live comparison of the three router modes through the real gateway: the same support messages
 * sent as `auto`, `auto-smart` and `auto-cascade`. It records where each request started, which
 * backend served it, the attempt trail, outcome, tokens, cost and latency. No judge: it answers
 * "what does each mode do and what does it cost", not "which answers are better" (use
 * `npm run eval -- --configs auto:v3,auto-smart:v3,auto-cascade:v3 --judge groq-strong` for that).
 *
 *   npm run router-modes-eval -- --base http://localhost:3000 [--delay 6000]
 *   npm run router-modes-eval -- --render results/<stamp>-router-modes.json   # re-render the .md
 *
 * Messages: the first 5 held-out eval cases, the hard cases that expect an answer, and 7 examples
 * written to exercise routing. Results: results/<stamp>-router-modes.{json,md}.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, "../../data");
const RESULTS = resolve(HERE, "results");
const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "true" : all[i + 1]]);
    return acc;
  }, []),
);
const BASE = args.base ?? "http://localhost:3000";
const KEY = args.key ?? process.env.EVAL_API_KEY ?? "sk-eval-demo-e7a1";
const ADMIN = args.admin ?? process.env.ADMIN_TOKEN ?? "admin-demo-token";
const DELAY = Number(args.delay ?? 6000);
const MODES = ["auto", "auto-smart", "auto-cascade"];

const EXAMPLES = [
  "why was I charged twice?",
  "I was charged twice, what payment methods do you accept and how do I get a refund?",
  "Compare the standard and express shipping options, explain the trade-offs and recommend one for a fragile item.",
  "My order arrived damaged. First tell me how to report it, then how long the refund takes?",
  "I bought 3 items at $17.50 each and was refunded $35. How much in total am I still owed?",
  "My refund for the cancelled order never arrived and now I've been charged again for the same order. What should I do first?",
  "The parcel shows delivered but I was away, and the invoice has the wrong address on it too.",
];

interface Row {
  set: string; id: string; message: string; model: string; status: number; outcome?: string; backend?: string;
  intent?: string; confidence?: number; costUsd?: number; tokens?: number; latencyMs?: number;
  rule?: string; reason?: string; attempts: string[];
}

async function run(): Promise<Row[]> {
  const read = (f: string) => JSON.parse(readFileSync(resolve(DATA, f), "utf8"));
  const rows = [
    ...read("eval.json").slice(0, 5).map((r: any) => ({ set: "eval", id: r.id, message: r.message })),
    ...read("eval-hard.json").filter((r: any) => r.expect !== "refuse").map((r: any) => ({ set: "hard", id: r.id, message: r.message })),
    ...EXAMPLES.map((m, i) => ({ set: "example", id: `ex-${i + 1}`, message: m })),
  ];
  const out: Row[] = [];
  for (const r of rows) {
    for (const model of MODES) {
      const res = await fetch(`${BASE}/v1/support/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ message: r.message, model, stream: false }),
      });
      const j: any = await res.json();
      const d: any = j.requestId ? await (await fetch(`${BASE}/admin/requests/${j.requestId}`, { headers: { "x-admin-token": ADMIN } })).json() : {};
      const row: Row = {
        ...r, model, status: res.status, outcome: j.outcome, backend: j.backend, intent: j.intent, confidence: j.confidence,
        costUsd: j.costUsd, tokens: j.usage?.totalTokens, latencyMs: j.latencyMs, rule: d.route_reason?.rule, reason: d.route_reason?.reason,
        attempts: (d.attempts ?? []).map((a: any) => `${a.backend}:${a.outcome}`),
      };
      out.push(row);
      console.log(r.id.padEnd(8), model.padEnd(13), String(j.outcome).padEnd(22), String(j.backend).padEnd(12), row.attempts.map((a) => a.split(":")[1]).join(">"));
      await new Promise((ok) => setTimeout(ok, DELAY));
    }
  }
  return out;
}

function render(rows: Row[], source: string): string {
  const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  const has = (r: Row, o: string) => r.attempts.some((a) => a.endsWith(`:${o}`));
  const lines = [
    `# Router modes, live (${source})`,
    "",
    "Same support messages, three router modes, real Groq models. Outcome counts are per mode; cost is metered by the gateway (classifier and escalated attempts included).",
    "",
    "| mode | n | success | refused | started on strong | served by strong | escalated (cascade) | attempts hit 429/empty | cost / 1k req | latency p50 | latency mean |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const m of MODES) {
    const rs = rows.filter((r) => r.model === m);
    const lat = rs.map((r) => r.latencyMs ?? 0);
    lines.push(
      `| \`${m}\` | ${rs.length} | ${rs.filter((r) => r.outcome === "success").length} | ${rs.filter((r) => r.outcome?.startsWith("refused")).length}` +
        ` | ${rs.filter((r) => r.rule?.endsWith("escalate_strong")).length} | ${rs.filter((r) => r.backend === "groq-strong").length}` +
        ` | ${rs.filter((r) => has(r, "escalated")).length} | ${rs.filter((r) => has(r, "error") || has(r, "unusable_output")).length}` +
        ` | $${((rs.reduce((n, r) => n + (r.costUsd ?? 0), 0) / rs.length) * 1000).toFixed(3)} | ${pct(lat, 0.5)} ms | ${Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)} ms |`,
    );
  }
  lines.push("", "## Every request", "", "| id | mode | outcome | served by | attempts | rule | reason |", "|---|---|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(`| ${r.id} | \`${r.model}\` | ${r.outcome} | ${r.backend ?? "-"} | ${r.attempts.join(" › ")} | \`${r.rule}\` | ${(r.reason ?? "").replace(/\|/g, "/")} |`);
  }
  lines.push("", "## Messages", "", ...[...new Map(rows.map((r) => [r.id, r.message])).entries()].map(([id, m]) => `- **${id}**: ${m}`));
  return lines.join("\n") + "\n";
}

if (args.render) {
  const file = resolve(process.cwd(), args.render);
  const rows: Row[] = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file.replace(/\.json$/, ".md"), render(rows, basename(file, ".json")));
  console.log(`rendered ${file.replace(/\.json$/, ".md")}`);
} else {
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-router-modes`;
  const rows = await run();
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(resolve(RESULTS, `${stamp}.json`), JSON.stringify(rows, null, 1));
  writeFileSync(resolve(RESULTS, `${stamp}.md`), render(rows, stamp));
  console.log(`wrote results/${stamp}.{json,md}`);
}
