/** SHA-256 for random secrets (API keys, session tokens). Passwords use scrypt instead (passwords.ts). */
import { createHash } from "node:crypto";

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
