/**
 * The error catalog (domain/errors.ts) is the contract: every code thrown in the source uses its
 * catalogued status, and every code is documented in docs/ERRORS.md.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERROR_CATALOG, GatewayError } from "../src/domain/errors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../src");
const DOC = readFileSync(resolve(HERE, "../../../docs/ERRORS.md"), "utf8");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []));

describe("error catalog", () => {
  it("documents every code in docs/ERRORS.md with its status", () => {
    const missing = Object.entries(ERROR_CATALOG)
      .filter(([code, info]) => !new RegExp(`\\|\\s*\`${code}\`\\s*\\|\\s*${info.status}\\s*\\|`).test(DOC))
      .map(([code]) => code);
    expect(missing).toEqual([]);
  });

  it("every GatewayError in the source uses its code's catalogued status", () => {
    const wrong = walk(SRC).flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/GatewayError\(\s*(\d{3}),\s*"([a-z_]+)"/g)]
        .filter(([, status, code]) => ERROR_CATALOG[code as keyof typeof ERROR_CATALOG]?.status !== Number(status))
        .map(([, status, code]) => `${f.slice(SRC.length + 1)}: ${status} ${code}`),
    );
    expect(wrong).toEqual([]);
  });

  it("serialises to the documented wire shape and knows if a retry can help", () => {
    const e = new GatewayError(429, "quota_exceeded", "Monthly token quota exhausted.", { tokensRemaining: 0 });
    expect(e.toJSON()).toEqual({ error: { code: "quota_exceeded", message: "Monthly token quota exhausted.", details: { tokensRemaining: 0 } } });
    expect(e.retryable).toBe(true);
    expect(new GatewayError(400, "invalid_request", "x").retryable).toBe(false);
  });
});
