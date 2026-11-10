/**
 * Behavioural probe on deliberately hard inputs (data/eval-hard.json): out-of-domain text that
 * slips past the retrieval gate, prompt injection inside a real request, multi-intent, vague,
 * non-English, typo-heavy and angry messages. Reports what the system DID, per case.
 *
 *   npm run probe -w @nalar-router/eval -- --base http://localhost:3000 --model groq-fast
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const BASE = arg("base", "http://localhost:3000");
const MODEL = arg("model", "auto");
const KEY = arg("key", "sk-eval-demo-e7a1");
const cases: any[] = JSON.parse(readFileSync(resolve(HERE, "../../data/eval-hard.json"), "utf8"));

const lines = [`| case | kind | message | expected | outcome | intent | conf | ok? |`, `|---|---|---|---|---|---|---|---|`];
let ok = 0;
for (const c of cases) {
  const r: any = await (
    await fetch(`${BASE}/v1/support/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ message: c.message, model: MODEL, stream: false }),
    })
  ).json();
  const refused = !!r.refused;
  const pass =
    c.expect === "either" ||
    (c.expect === "refuse" && refused) ||
    (c.expect === "answer" && !refused && r.outcome === "success" && (!c.expectedIntent || r.intent === c.expectedIntent));
  if (pass) ok++;
  const leaked = /allowed intent labels|never reveal/i.test(r.answer ?? "");
  lines.push(
    `| ${c.id} | ${c.kind} | ${c.message} | ${c.expect}${c.expectedIntent ? ` (${c.expectedIntent})` : ""} | ${r.outcome}${r.refusal ? ` (${r.refusal.reason})` : ""} | ${r.intent ?? "–"} | ${r.confidence ?? "–"} | ${pass ? "✓" : "✗"}${leaked ? " LEAK" : ""} |`,
  );
  console.log(lines.at(-1));
  await new Promise((s) => setTimeout(s, Number(arg("delay", "4000"))));
}
const md = `# Hard-case probe (${MODEL}) ${new Date().toISOString()}\n\n${ok}/${cases.length} behaved as expected\n\n${lines.join("\n")}\n`;
mkdirSync(resolve(HERE, "results"), { recursive: true });
const out = resolve(HERE, `results/probe-${MODEL}.md`);
writeFileSync(out, md);
console.log(`\n${ok}/${cases.length} as expected → ${out}`);
