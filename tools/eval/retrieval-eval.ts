/**
 * LLM-free check of the retrieval layer on 1,350 held-out rows + OOD prompts:
 *  - kNN intent accuracy (score-weighted vote of top-k)
 *  - recall@k: is any hit of the right intent in the top-k
 *  - coverage distribution in-domain vs out-of-domain (used to pick the refusal gate)
 *
 *   npm run retrieval-eval
 */
import { readFileSync } from "node:fs";
import { Bm25Index, type KbEntry } from "../../apps/gateway/src/support/retrieval.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, "../../data");


const kb: KbEntry[] = JSON.parse(readFileSync(resolve(DATA, "kb.json"), "utf8"));
const holdout: { message: string; expectedIntent: string }[] = JSON.parse(
  readFileSync(resolve(DATA, "retrieval-holdout.json"), "utf8"),
);
const ood: { message: string }[] = JSON.parse(readFileSync(resolve(DATA, "eval-ood.json"), "utf8"));
const extraOod = [
  "hi",
  "tell me a joke",
  "what is the meaning of life",
  "how do I fix my car engine",
  "translate hello into french",
  "what's bitcoin price today",
  "book me a flight to Bali",
  "my cat is sick what should I do",
];

const t0 = performance.now();
const idx = new Bm25Index(kb);
const buildMs = performance.now() - t0;

let correct = 0;
let recall = 0;
const covIn: number[] = [];
const shareIn: number[] = [];
const t1 = performance.now();
for (const c of holdout) {
  const r = idx.search(c.message, 8);
  if (r.topIntent === c.expectedIntent) correct++;
  if (r.hits.some((h) => h.entry.intent === c.expectedIntent)) recall++;
  covIn.push(r.coverage);
  shareIn.push(r.topShare);
}
const perQueryMs = (performance.now() - t1) / holdout.length;
const covOod = [...ood.map((o) => o.message), ...extraOod].map((m) => ({ m, cov: idx.search(m, 8).coverage }));

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)];
console.log(`KB entries: ${kb.length}, index build ${buildMs.toFixed(0)} ms, ${perQueryMs.toFixed(2)} ms/query`);
console.log(`held-out n=${holdout.length}`);
console.log(`  kNN intent accuracy: ${((100 * correct) / holdout.length).toFixed(1)}%`);
console.log(`  recall@8 (right intent anywhere in top-8): ${((100 * recall) / holdout.length).toFixed(1)}%`);
console.log(
  `  coverage in-domain p01=${pct(covIn, 0.01).toFixed(2)} p05=${pct(covIn, 0.05).toFixed(2)} p50=${pct(covIn, 0.5).toFixed(2)}`,
);
console.log(`  top vote share p10=${pct(shareIn, 0.1).toFixed(2)} p50=${pct(shareIn, 0.5).toFixed(2)}`);
for (const th of [0.2, 0.25, 0.3, 0.34, 0.4, 0.5]) {
  const falseOut = covIn.filter((c) => c < th).length;
  const caught = covOod.filter((o) => o.cov < th).length;
  console.log(
    `  gate coverage<${th}: in-domain wrongly gated ${falseOut}/${covIn.length} (${((100 * falseOut) / covIn.length).toFixed(1)}%), OOD caught ${caught}/${covOod.length}`,
  );
}
console.log("OOD coverage:");
for (const o of covOod) console.log(`  ${o.cov.toFixed(2)}  ${o.m}`);
