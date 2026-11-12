/**
 * Password hashing with scrypt (memory-hard, in node:crypto, no native dependency).
 * Parameters follow the OWASP password storage cheat sheet (N=2^17, r=8, p=1) and are
 * stored inside each hash, so they can be raised later without breaking old hashes.
 * Format: scrypt$<log2N>$<r>$<p>$<salt b64url>$<hash b64url>
 */
import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { PasswordVerifier } from "../../../use-cases/ports/identity.js";

const KEYLEN = 32;
// tests lower the cost through the environment; production uses the OWASP default
const LOG2N = Number(process.env.AUTH_SCRYPT_LOG2N ?? 17);
const R = 8;
const P = 1;

const opts = (log2n: number, r: number, p: number): ScryptOptions => ({
  N: 2 ** log2n, r, p, maxmem: 128 * r * 2 ** log2n * 2 + 1024 * 1024,
});

const scryptAsync = (pw: string, salt: Buffer, o: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scrypt(pw.normalize("NFKC"), salt, KEYLEN, o, (e, k) => (e ? rej(e) : res(k))));

export function hashPasswordSync(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize("NFKC"), salt, KEYLEN, opts(LOG2N, R, P));
  return ["scrypt", LOG2N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, opts(LOG2N, R, P));
  return ["scrypt", LOG2N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  const key = await scryptAsync(password, Buffer.from(salt, "base64url"), opts(Number(n), Number(r), Number(p)));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/**
 * Unknown emails still pay for one scrypt run against this hash, so response time
 * does not reveal whether an account exists.
 */
let dummy: string | null = null;
export function dummyHash() {
  dummy ??= hashPasswordSync(randomBytes(16).toString("hex"));
  return dummy;
}

/** the PasswordVerifier port on scrypt */
export const scryptPasswords: PasswordVerifier = { verify: verifyPassword, dummyHash };
