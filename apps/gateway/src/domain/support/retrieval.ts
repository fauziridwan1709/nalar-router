/**
 * In-process BM25 retrieval over the KB slice.
 *
 * Why BM25 and not embeddings: Bitext questions are short, template-generated and
 * lexically very regular, so a lexical ranker is strong here, has zero marginal cost,
 * needs no second model/provider in the request path, is deterministic (testable),
 * and builds in ~50 ms at boot. Measured accuracy is in docs/REPORT.md.
 */
export interface KbEntry {
  id: string;
  question: string;
  intent: string;
  category: string;
  answer: string;
}

export interface Hit {
  entry: KbEntry;
  score: number;
}

export interface RetrievalResult {
  hits: Hit[];
  /** score-weighted share of the top-k per intent, sorted desc */
  votes: { intent: string; share: number }[];
  topIntent: string | null;
  topShare: number;
  /** IDF-weighted fraction of query terms found in the top hits (0..1). Low = out of scope. */
  coverage: number;
  /** absolute IDF mass of query terms found in the top hits (not diluted by extra chatter) */
  matchedWeight: number;
  queryTerms: string[];
}

const STOP = new Set(
  "a an the i me my we our you your to of in on for with at by from is are was were be been am do does did can could would should will shall may might must have has had it its this that these those and or but if so as please pls want need help hi hello hey there how what when where which who why im i'm id i'd ive i've wanna gotta just some any about into up out get got".split(
    " ",
  ),
);

export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\{\{[^}]*\}\}/g, " ") // drop {{Order Number}} style placeholders
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

export class Bm25Index {
  private docs: { terms: Map<string, number>; len: number }[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;
  constructor(
    public readonly entries: KbEntry[],
    private k1 = 1.2,
    private b = 0.75,
  ) {
    let total = 0;
    for (const e of entries) {
      const toks = tokenize(e.question);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ terms: tf, len: toks.length });
      total += toks.length;
    }
    this.avgLen = total / Math.max(1, entries.length);
  }

  idf(term: string): number {
    const n = this.df.get(term) ?? 0;
    return Math.log(1 + (this.entries.length - n + 0.5) / (n + 0.5));
  }

  /**
   * Typo tolerance: a query term the KB has never seen is mapped to the most frequent
   * vocabulary term within edit distance 1 (2 for words ≥ 8 chars). Without this,
   * "pasword" is an unseen, maximum-IDF term and drags coverage down → false refusal.
   */
  correct(term: string): string {
    if (this.df.has(term) || term.length < 4 || /\d/.test(term)) return term;
    const maxD = term.length >= 8 ? 2 : 1;
    let best: string | null = null;
    let bestDf = 0;
    for (const [v, df] of this.df) {
      if (Math.abs(v.length - term.length) > maxD || df <= bestDf) continue;
      if (editDistance(term, v, maxD) <= maxD) {
        best = v;
        bestDf = df;
      }
    }
    return best ?? term;
  }

  search(query: string, k = 8): RetrievalResult {
    const qTerms = [...new Set(tokenize(query).map((t) => this.correct(t)))];
    const scored: Hit[] = [];
    if (qTerms.length) {
      const idfs = qTerms.map((t) => this.idf(t));
      for (let i = 0; i < this.docs.length; i++) {
        const d = this.docs[i];
        let s = 0;
        for (let j = 0; j < qTerms.length; j++) {
          const f = d.terms.get(qTerms[j]);
          if (!f) continue;
          s += idfs[j] * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen)));
        }
        if (s > 0) scored.push({ entry: this.entries[i], score: s });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, k);

    const byIntent = new Map<string, number>();
    const sum = hits.reduce((n, h) => n + h.score, 0);
    for (const h of hits) byIntent.set(h.entry.intent, (byIntent.get(h.entry.intent) ?? 0) + h.score);
    const votes = [...byIntent.entries()]
      .map(([intent, s]) => ({ intent, share: sum ? s / sum : 0 }))
      .sort((a, b) => b.share - a.share);

    // coverage: how much of the (IDF-weighted) query is explained by the top-3 hits.
    // Terms the KB has never seen get a high IDF, so off-topic questions score ~0.
    let covered = 0;
    let totalW = 0;
    const top = hits.slice(0, 3);
    for (const t of qTerms) {
      const w = this.idf(t);
      totalW += w;
      if (top.some((h) => tokenize(h.entry.question).includes(t))) covered += w;
    }
    return {
      hits,
      votes,
      topIntent: votes[0]?.intent ?? null,
      topShare: votes[0]?.share ?? 0,
      coverage: totalW ? covered / totalW : 0,
      matchedWeight: covered,
      queryTerms: qTerms,
    };
  }
}

export function voteShareFor(r: RetrievalResult, intent: string): number {
  return r.votes.find((v) => v.intent === intent)?.share ?? 0;
}

/** Damerau-Levenshtein (optimal string alignment) with early exit above `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  let prev2 = new Array(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}
