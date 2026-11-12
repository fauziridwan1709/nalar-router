/**
 * The console's dependency rule, checked on every test run:
 *
 *   domain  ←  application  ←  infrastructure / ui  ←  main.tsx (composition root)
 *
 * - domain/          types and pure rules (formatting, access, quota standing, outcome groups,
 *                    the playground event reducer, code snippets); imports only domain/
 * - application/     the ConsoleApi port, its React provider, and data hooks; imports domain/
 * - infrastructure/  the HTTP adapter for the port (fetch, CSRF, SSE parsing); no React
 * - ui/              pages and components; talks to the gateway only through useApi()
 * - main.tsx         builds the adapter and renders the app with it
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.tsx?$/.test(f) && !f.endsWith(".d.ts") ? [join(d, f)] : []));
const layerOf = (file: string) => {
  const rel = relative(SRC, file);
  return rel === "main.tsx" ? "root" : rel.split("/")[0];
};
const resolveSpec = (from: string, spec: string) => {
  const base = resolve(dirname(from), spec);
  for (const ext of ["", ".ts", ".tsx"]) {
    try {
      if (statSync(base + ext).isFile()) return base + ext;
    } catch {
      /* try the next extension */
    }
  }
  return base;
};
function importsOf(file: string) {
  return [...readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\s+(?:type\s+)?[^'"]*?from\s+["']([^"']+)["']/gm)].map((m) => ({
    spec: m[1],
    layer: m[1].startsWith(".") ? layerOf(resolveSpec(file, m[1])) : "external",
  }));
}

const ALLOWED: Record<string, string[]> = {
  domain: ["domain"],
  application: ["domain", "application"],
  infrastructure: ["domain", "application", "infrastructure"],
  ui: ["domain", "application", "ui"],
  root: ["domain", "application", "infrastructure", "ui", "root"],
};

describe("console architecture: dependencies point inward", () => {
  const files = walk(SRC);

  it("every source file sits in a known layer", () => {
    expect(files.filter((f) => !(layerOf(f) in ALLOWED)).map((f) => relative(SRC, f))).toEqual([]);
  });

  it("no layer imports an outer one; the UI never reaches the HTTP adapter", () => {
    const bad = files.flatMap((f) =>
      importsOf(f).filter((i) => i.layer !== "external" && !ALLOWED[layerOf(f)].includes(i.layer)).map((i) => `${relative(SRC, f)} → ${i.spec}`),
    );
    expect(bad).toEqual([]);
  });

  it("domain has no React, and only infrastructure calls fetch", () => {
    const reactInDomain = files
      .filter((f) => layerOf(f) === "domain")
      .flatMap((f) => importsOf(f).filter((i) => /^react|^@astryxdesign|^lucide/.test(i.spec)).map((i) => `${relative(SRC, f)} → ${i.spec}`));
    expect(reactInDomain).toEqual([]);
    const fetchOutside = files.filter((f) => layerOf(f) !== "infrastructure" && /(?<![.\w])fetch\(/.test(readFileSync(f, "utf8").replace(/`[^`]*`/g, "")));
    expect(fetchOutside.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("no page builds a console API URL itself", () => {
    const urls = files.filter((f) => layerOf(f) !== "infrastructure" && /["'`]\/api\/(console|auth)\//.test(readFileSync(f, "utf8")));
    expect(urls.map((f) => relative(SRC, f))).toEqual([]);
  });
});
