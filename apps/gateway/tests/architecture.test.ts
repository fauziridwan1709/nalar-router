/**
 * The dependency rule of the clean architecture, checked on every test run:
 *
 *   domain  ←  application  ←  infrastructure / interfaces  ←  composition root
 *
 * - domain/          business rules; imports only domain/ (no node:, no express, no sqlite, no zod)
 * - application/     use cases and the ports they need; imports domain/ and application/ only
 * - infrastructure/  adapters for the ports (SQLite, model providers, health probes)
 * - interfaces/      delivery (HTTP); turns requests into use-case calls
 * - config.ts, gateway.ts, index.ts: the composition root, which wires everything
 *
 * Infrastructure and interfaces never import each other, except that the HTTP layer may read
 * infrastructure's query helpers for read-only reporting screens (metrics, logs, keys), which
 * have no business rules to put in a use case.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const ROOT_FILES = new Set(["config.ts", "gateway.ts", "index.ts"]);

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []));

const layerOf = (file: string) => {
  const rel = relative(SRC, file);
  return ROOT_FILES.has(rel) ? "root" : rel.split("/")[0];
};

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
  domain: ["domain"],
  application: ["domain", "application"],
  infrastructure: ["domain", "application", "infrastructure"],
  interfaces: ["domain", "application", "interfaces", "infrastructure"],
  root: ["domain", "application", "infrastructure", "interfaces", "root"],
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
        // a type-only import of the composed Gateway/Config is how adapters receive their dependencies
        .filter((i) => !(i.typeOnly && i.layer === "root" && layer !== "domain" && layer !== "application"))
        .map((i) => `${relative(SRC, f)} → ${i.spec}`);
    });
    expect(violations).toEqual([]);
  });

  it("domain and application have no framework or I/O dependencies", () => {
    const banned = /^(node:(fs|sqlite|http|net|child_process)|express|zod)$/;
    const violations = files
      .filter((f) => ["domain", "application"].includes(layerOf(f)))
      .flatMap((f) => importsOf(f).filter((i) => i.layer === "external" && banned.test(i.spec)).map((i) => `${relative(SRC, f)} → ${i.spec}`));
    expect(violations).toEqual([]);
  });
});
