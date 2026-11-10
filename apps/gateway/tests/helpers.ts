import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { config as baseConfig, type BackendConfig } from "../src/config.js";
import { openDb, type SeedTenant } from "../src/db.js";
import { createGateway, type Gateway } from "../src/gateway.js";
import { createApp } from "../src/http/app.js";
import type { Backend, BackendRequest, StreamChunk } from "../src/backends/types.js";
import { abortableSleep } from "../src/backends/chaos.js";
import type { KbEntry } from "../src/support/retrieval.js";

export const KB: KbEntry[] = [
  { id: "c1", question: "how do I cancel my order", intent: "cancel_order", category: "ORDER", answer: "To cancel order {{Order Number}}, go to Orders and press Cancel." },
  { id: "c2", question: "I want to cancel order {{Order Number}}", intent: "cancel_order", category: "ORDER", answer: "You can cancel from the Orders page." },
  { id: "c3", question: "help cancelling purchase", intent: "cancel_order", category: "ORDER", answer: "Cancel via Orders > Cancel." },
  { id: "t1", question: "where is my package, track order", intent: "track_order", category: "ORDER", answer: "Track it in Orders > Track." },
  { id: "t2", question: "track my order status", intent: "track_order", category: "ORDER", answer: "Use the tracking link." },
  { id: "r1", question: "I want a refund for my purchase", intent: "get_refund", category: "REFUND", answer: "Request a refund in Orders > Refund." },
  { id: "r2", question: "how to get my money back refund", intent: "get_refund", category: "REFUND", answer: "Refunds take 5-7 days." },
];

export const TENANTS: SeedTenant[] = [
  {
    id: "pro", name: "Pro", plan: "pro", apiKey: "k-pro", allowedTiers: ["fast", "strong", "degraded"], tokenQuota: 100_000, requestQuota: 100,
    profile: { "Customer Support Phone Number": "+62 21 555 0100", "Website URL": "pro.example" },
  },
  { id: "free", name: "Free", plan: "free", apiKey: "k-free", allowedTiers: ["fast", "degraded"], tokenQuota: 100_000, requestQuota: 100 },
  { id: "tiny", name: "Tiny", plan: "trial", apiKey: "k-tiny", allowedTiers: ["fast", "degraded"], tokenQuota: 900, requestQuota: 2 },
];

export type Script = (req: BackendRequest) => AsyncIterable<StreamChunk>;

/** Scriptable fake backend for deterministic tests. */
export class FakeBackend implements Backend {
  calls = 0;
  constructor(
    public config: BackendConfig,
    public script: Script,
  ) {}
  stream(req: BackendRequest) {
    this.calls++;
    return this.script(req);
  }
}

export function cfg(id: string, tier: BackendConfig["tier"], over: Partial<BackendConfig> = {}): BackendConfig {
  return {
    id, kind: "openai-compatible", location: "cloud", tier, model: `${id}-model`, priceInPerM: 1, priceOutPerM: 2,
    firstTokenTimeoutMs: 300, totalTimeoutMs: 2_000, enabled: true, ...over,
  };
}

export const reply = (text: string, usage = { promptTokens: 100, completionTokens: 20 }, delayMs = 0): Script =>
  async function* (req) {
    for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
      if (delayMs) await abortableSleep(delayMs, req.signal);
      yield { type: "text", text: piece };
    }
    yield { type: "usage", ...usage };
  };

/** a "thinking" model: reasoning chunks first, then the answer */
export const think = (thought: string, text: string): Script =>
  async function* (req) {
    if (req.includeReasoning) for (const w of thought.split(" ")) yield { type: "reasoning", text: w + " " };
    yield* reply(text)(req);
  };

export const fail = (msg = "boom"): Script =>
  async function* () {
    throw Object.assign(new Error(msg));
  };

export const hang: Script = async function* (req) {
  await abortableSleep(60_000, req.signal);
};

export async function startServer(backends: Backend[], over: { demoMode?: boolean } = {}) {
  const config = { ...baseConfig, demoMode: over.demoMode ?? true, adminToken: "adm" };
  const gw: Gateway = createGateway(config, { db: openDb(":memory:", TENANTS), backends, kbEntries: KB });
  const app = createApp(gw);
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { gw, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export async function sse(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("event:"))
    .map((b) => {
      const [e, d] = b.split("\n");
      return { event: e.slice(7), data: JSON.parse(d.slice(6)) };
    });
}
