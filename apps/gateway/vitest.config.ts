import { defineConfig } from "vitest/config";

export default defineConfig({
  // scrypt at the production cost (2^17) would make every test boot slow; the format stores the cost per hash
  test: { env: { AUTH_SCRYPT_LOG2N: "10" } },
});
