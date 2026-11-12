/** The EvalResults port on the file system: committed eval runs in tools/eval/results/*.json. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvalResults } from "../../../use-cases/ports/operations.js";

export const fileEvalResults = (dir: string): EvalResults => ({
  list() {
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse() : [];
    return files.flatMap((f) => {
      try {
        const r = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
        return [{ file: f, stamp: r.stamp, judge: r.judge, n: r.n, configs: r.configs.map(({ rows: _rows, ...c }: any) => c) }];
      } catch {
        return [];
      }
    });
  },
});
