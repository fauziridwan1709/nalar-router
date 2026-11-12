/**
 * The console's dependency rule, checked on every test run. The folders are the four circles of
 * Robert C. Martin's Clean Architecture (2012); source code dependencies point only inward:
 *
 *   entities  ←  use-cases  ←  interface-adapters  ←  frameworks  ←  main.tsx
 *
 * - entities/            Entities: the console's vocabulary (models.ts) and pure rules (formatting,
 *                        access, quota standing, outcome groups, the playground event reducer,
 *                        code snippets). Imports only entities/; no React, no I/O.
 * - use-cases/           Use Cases: the ConsoleApi port (ports.ts), the boundary every screen talks
 *                        through. Imports entities/ only; no React.
 * - interface-adapters/  Interface Adapters: gateways/http implements the port over the gateway's
 *                        console API (fetch, CSRF, SSE parsing). The only place that calls fetch
 *                        or builds a console API URL; no React.
 * - frameworks/          Frameworks & Drivers: ui/ is React (app shell, pages, components, styles,
 *                        and the hooks that hand the port to pages). Pages reach the gateway only
 *                        through useApi(), never through the HTTP adapter.
 * - main.tsx             Main: the composition root. Builds the HTTP adapter and renders the app with it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) =>
    statSync(join(d, f)).isDirectory()
      ? walk(join(d, f))
      : /\.tsx?$/.test(f) && !f.endsWith(".d.ts")
        ? [join(d, f)]
        : [],
  );
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
  return [
    ...readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\s+(?:type\s+)?[^'"]*?from\s+["']([^"']+)["']/gm),
  ].map((m) => ({
    spec: m[1],
    layer: m[1].startsWith(".") ? layerOf(resolveSpec(file, m[1])) : "external",
  }));
}

const isHttpGateway = (f: string) => relative(SRC, f).startsWith("interface-adapters/gateways/http/");

const ALLOWED: Record<string, string[]> = {
  entities: ["entities"],
  "use-cases": ["entities", "use-cases"],
  "interface-adapters": ["entities", "use-cases", "interface-adapters"],
  // frameworks may import interface-adapters by the rule, but the UI is held to the port: see below
  frameworks: ["entities", "use-cases", "frameworks"],
  root: ["entities", "use-cases", "interface-adapters", "frameworks", "root"],
};
const REACT = /^react|^@astryxdesign|^lucide|^@fontsource/;

describe("console architecture: dependencies point inward", () => {
  const files = walk(SRC);

  it("every source file sits in a known layer", () => {
    expect(files.filter((f) => !(layerOf(f) in ALLOWED)).map((f) => relative(SRC, f))).toEqual([]);
  });

  it("no layer imports an outer one; the UI never reaches the HTTP adapter", () => {
    const bad = files.flatMap((f) =>
      importsOf(f)
        .filter((i) => i.layer !== "external" && !ALLOWED[layerOf(f)].includes(i.layer))
        .map((i) => `${relative(SRC, f)} → ${i.spec}`),
    );
    expect(bad).toEqual([]);
  });

  it("React lives only in frameworks/ and main.tsx", () => {
    const inner = files.filter((f) => !["frameworks", "root"].includes(layerOf(f)));
    const reactImports = inner.flatMap((f) =>
      importsOf(f)
        .filter((i) => REACT.test(i.spec))
        .map((i) => `${relative(SRC, f)} → ${i.spec}`),
    );
    expect(reactImports).toEqual([]);
    expect(inner.filter((f) => f.endsWith(".tsx")).map((f) => relative(SRC, f))).toEqual([]);
  });

  it("only the HTTP gateway calls fetch", () => {
    const fetchOutside = files.filter(
      (f) => !isHttpGateway(f) && /(?<![.\w])fetch\(/.test(readFileSync(f, "utf8").replace(/`[^`]*`/g, "")),
    );
    expect(fetchOutside.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("no page builds a console API URL itself", () => {
    const urls = files.filter((f) => !isHttpGateway(f) && /["'`]\/api\/(console|auth)\//.test(readFileSync(f, "utf8")));
    expect(urls.map((f) => relative(SRC, f))).toEqual([]);
  });
});
