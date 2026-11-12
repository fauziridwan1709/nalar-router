/**
 * LLM-free check of auto routing: for every message in the eval sets plus a set of example
 * queries, which tier does the router start at, and why? Compares the complexity analyzer with
 * the rule it replaced (escalate only on > 60 tokens or retrieval vote share < 0.6).
 *
 *   npm run routing-eval            # summary + every message whose route changed
 *   npm run routing-eval -- --all   # every message
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Bm25Index, type KbEntry } from "../../apps/gateway/src/domain/support/retrieval.js";
import { assessComplexity } from "../../apps/gateway/src/domain/routing/complexity.js";
import { estimateTokens } from "../../apps/gateway/src/domain/tokens.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, "../../data");
const read = (f: string) => JSON.parse(readFileSync(resolve(DATA, f), "utf8"));
const opts = { longQueryTokens: 60, ambiguousVoteShare: 0.6, complexityThreshold: 0.5 };
const kb = new Bm25Index(read("kb.json") as KbEntry[]);

/** queries written to exercise each signal; the support set only has short templated questions */
const EXAMPLES = [
  "how can I cancel my order 12345?",
  "why was I charged twice?",
  "i forgot my pasword and cant log in",
  "I was charged twice, what payment methods do you accept and how do I get a refund?",
  "Compare the standard and express shipping options, explain the trade-offs and recommend one for a fragile item.",
  "My order arrived damaged. First tell me how to report it, then how long the refund takes?",
  "Can you help me with these: 1. change my address 2. update my phone 3. cancel the old order",
  "I bought 3 items at $17.50 each and was refunded $35. How much in total am I still owed?",
  "Why does this fail? ```js\nfetch(url).then(r => r.json())\n```",
  "Reply in JSON only, with at most 3 fields and no more than 20 words per field: what is your refund policy?",
];

type Row = { set: string; message: string };
const rows: Row[] = [
  ...read("eval.json").map((r: any) => ({ set: "eval", message: r.message })),
  ...read("eval-hard.json").map((r: any) => ({ set: "hard", message: r.message })),
  ...read("eval-ood.json").map((r: any) => ({ set: "ood", message: r.message })),
  ...EXAMPLES.map((m) => ({ set: "example", message: m })),
];

const all = process.argv.includes("--all");
let oldStrong = 0;
let newStrong = 0;
let changed = 0;
const lines: string[] = [];
for (const r of rows) {
  const retrieval = kb.search(r.message, 8);
  const queryTokens = estimateTokens(r.message);
  const before = queryTokens > opts.longQueryTokens || retrieval.topShare < opts.ambiguousVoteShare;
  const c = assessComplexity({ text: r.message, queryTokens, retrievalTopShare: retrieval.topShare }, opts);
  const after = c.score >= opts.complexityThreshold;
  oldStrong += +before;
  newStrong += +after;
  if (before !== after) changed++;
  if (all || before !== after || r.set === "example") {
    const sig = c.signals.map((s) => `${s.id}+${s.weight}`).join(" ") || "none";
    lines.push(
      `${r.set.padEnd(7)} ${(before ? "strong" : "fast").padEnd(6)} → ${(after ? "strong" : "fast").padEnd(6)} ${c.score.toFixed(2)} ${c.level.padEnd(8)} [${sig}]\n        ${r.message.replace(/\n/g, " ").slice(0, 110)}`,
    );
  }
}
console.log(`${rows.length} messages (eval ${rows.filter((r) => r.set === "eval").length}, hard ${rows.filter((r) => r.set === "hard").length}, ood ${rows.filter((r) => r.set === "ood").length}, examples ${EXAMPLES.length})`);
console.log(`strong tier first: old rule ${oldStrong}, complexity ${newStrong}; route changed for ${changed}\n`);
console.log("set     old    → new    score level    [signals]");
console.log(lines.join("\n"));
