/**
 * The Dependency Rule of Robert C. Martin's Clean Architecture ("The Clean Architecture", 2012;
 * "Clean Architecture", 2017), checked on every test run. Source code dependencies point inward:
 *
 *   entities  ←  use-cases  ←  interface-adapters  ←  frameworks  ←  main
 *
 * - entities/            Enterprise Business Rules: routing policy, quota rule, metering math, PII
 *                        detection, retrieval, RBAC, errors. Imports only entities/.
 * - use-cases/           Application Business Rules: the capability path, support, chat, fallback,
 *                        console and key management, and the ports (interfaces) they need.
 * - interface-adapters/  Controllers (HTTP routes), Presenters (SSE, OpenAI wire format, errors) and
 *                        Gateways (SQLite repositories, LLM providers, health probes, eval files).
 * - frameworks/          Frameworks & Drivers: the Express app and the SQLite driver (schema, seed).
 * - main/                The Main component: config loading, the composition root, the process.
 *
 * Express and node:sqlite are started only in frameworks/; interface-adapters may use their types.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []));

const layerOf = (file: string) => relative(SRC, file).split("/")[0];

/** every import of a file: [specifier, resolved layer or "external", type-only?] */
function importsOf(file: string) {
  const src = readFileSync(file, "utf8");
  const out: { spec: string; layer: string; typeOnly: boolean }[] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+["']([^"']+)["']/gm)) {
    const spec = m[3];
    const layer = spec.startsWith(".") ? layerOf(resolve(dirname(file), spec.replace(/\.js$/, ".ts"))) : "external";
    out.push({ spec, layer, typeOnly: !!m[2] });
  }
  return out;
}

const ALLOWED: Record<string, string[]> = {
  entities: ["entities"],
  "use-cases": ["entities", "use-cases"],
  "interface-adapters": ["entities", "use-cases", "interface-adapters"],
  frameworks: ["entities", "use-cases", "interface-adapters", "frameworks"],
  main: ["entities", "use-cases", "interface-adapters", "frameworks", "main"],
};

describe("architecture: dependencies point inward", () => {
  const files = walk(SRC);

  it("every source file sits in a known layer", () => {
    const unknown = files.filter((f) => !(layerOf(f) in ALLOWED)).map((f) => relative(SRC, f));
    expect(unknown).toEqual([]);
  });

  it("no layer imports an outer layer", () => {
    const violations = files.flatMap((f) => {
      const layer = layerOf(f);
      return importsOf(f)
        .filter((i) => i.layer !== "external" && !ALLOWED[layer].includes(i.layer))
        .map((i) => `${relative(SRC, f)} → ${i.spec}`);
    });
    expect(violations).toEqual([]);
  });

  it("entities and use cases have no framework or I/O dependencies", () => {
    const banned = /^(node:(fs|sqlite|http|net|child_process)|express|zod)$/;
    const violations = files
      .filter((f) => ["entities", "use-cases"].includes(layerOf(f)))
      .flatMap((f) => importsOf(f).filter((i) => i.layer === "external" && banned.test(i.spec)).map((i) => `${relative(SRC, f)} → ${i.spec}`));
    expect(violations).toEqual([]);
  });

  it("interface adapters use Express and SQLite types only; frameworks/ runs them", () => {
    const violations = files
      .filter((f) => layerOf(f) === "interface-adapters")
      .flatMap((f) => importsOf(f).filter((i) => /^(express|node:sqlite)$/.test(i.spec) && !i.typeOnly).map((i) => `${relative(SRC, f)} → ${i.spec}`));
    expect(violations).toEqual([]);
  });
});
