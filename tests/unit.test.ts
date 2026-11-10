import { describe, expect, it } from "vitest";
import { SupportOutputParser, parseHeader } from "../server/support/parser.js";
import { Bm25Index } from "../server/support/retrieval.js";
import { planRoute } from "../server/router/policy.js";
import { CircuitBreaker } from "../server/router/breaker.js";
import { executeWithFallback } from "../server/router/executor.js";
import { BackendError } from "../server/errors.js";
import { admit, getUsage } from "../server/quota.js";
import { openDb } from "../server/db.js";
import { getTenant } from "../server/tenants.js";
import { FakeBackend, KB, TENANTS, cfg, fail, hang, reply } from "./helpers.js";

const INTENTS = new Set(["cancel_order", "track_order", "get_refund", "unknown"]);
const tenant = (id: string) => {
  const t = TENANTS.find((x) => x.id === id)!;
  return { id: t.id, name: t.name, plan: t.plan, allowedTiers: t.allowedTiers, tokenQuota: t.tokenQuota, requestQuota: t.requestQuota, quotaResetAt: 0 };
};

describe("output parser", () => {
  it("parses header split across chunks and returns answer text", () => {
    const p = new SupportOutputParser(INTENTS);
    expect(p.push('{"intent":"cancel_')).toBe("");
    expect(p.push('order","confidence":0.9}\n##')).toBe("");
    expect(p.push("#\nTo cancel")).toBe("To cancel");
    expect(p.parsedHeader).toEqual({ intent: "cancel_order", modelConfidence: 0.9 });
    expect(p.push(" your order")).toBe(" your order");
  });
  it("tolerates code fences, <think> blocks and percent confidence", () => {
    const p = new SupportOutputParser(INTENTS);
    p.push("<think>hmm</think>```json\n{\"intent\": \"get_refund\", \"confidence\": 85}\n```\n###\nSure");
    expect(p.parsedHeader).toEqual({ intent: "get_refund", modelConfidence: 0.85 });
  });
  it("rejects unknown labels and non-JSON as unusable", () => {
    expect(() => parseHeader('{"intent":"buy_pizza","confidence":1}', INTENTS)).toThrow(/unknown intent/);
    expect(() => parseHeader("I think you want to cancel", INTENTS)).toThrow(BackendError);
  });
  it("gives up when no separator appears within the header budget", () => {
    const p = new SupportOutputParser(INTENTS);
    expect(() => p.push("x".repeat(700))).toThrow(/no header separator/);
  });
  it("accepts a header without ### at end of stream", () => {
    const p = new SupportOutputParser(INTENTS);
    p.push('{"intent":"track_order","confidence":0.7}\nIt is on the way.');
    expect(p.end()).toBe("It is on the way.");
  });
});

describe("retrieval", () => {
  const idx = new Bm25Index(KB);
  it("ranks the right intent first and reports coverage", () => {
    const r = idx.search("please cancel my order", 5);
    expect(r.topIntent).toBe("cancel_order");
    expect(r.coverage).toBeGreaterThan(0.5);
  });
  it("gives ~0 coverage to off-topic text", () => {
    expect(idx.search("write a poem about the ocean").coverage).toBeLessThan(0.2);
  });
});

describe("routing policy", () => {
  const backends = [new FakeBackend(cfg("f", "fast"), fail()), new FakeBackend(cfg("s", "strong"), fail()), new FakeBackend(cfg("m", "degraded"), fail())];
  const opts = { longQueryTokens: 60, ambiguousVoteShare: 0.6 };
  it("defaults to fast with fallback chain", () => {
    const p = planRoute(backends, tenant("pro"), { queryTokens: 10, retrievalTopShare: 0.9 }, opts);
    expect(p.chain.map((b) => b.config.id)).toEqual(["f", "s", "m"]);
    expect(p.rule).toBe("auto_default_fast");
  });
  it("escalates ambiguous or long queries to strong", () => {
    expect(planRoute(backends, tenant("pro"), { queryTokens: 10, retrievalTopShare: 0.4 }, opts).chain[0].config.id).toBe("s");
    expect(planRoute(backends, tenant("pro"), { queryTokens: 200, retrievalTopShare: 1 }, opts).rule).toBe("auto_escalate_strong");
  });
  it("never routes outside the tenant plan", () => {
    const p = planRoute(backends, tenant("free"), { queryTokens: 200 }, opts);
    expect(p.chain.map((b) => b.config.id)).toEqual(["f", "m"]);
    expect(p.rule).toBe("auto_escalate_denied_by_plan");
    expect(() => planRoute(backends, tenant("free"), { queryTokens: 1, hint: "strong" }, opts)).toThrow(/does not include/);
  });
});

describe("executor", () => {
  const consumeAll = async (text: AsyncIterable<string>, ctx: { commit(): void }) => {
    let any = false;
    for await (const t of text) {
      if (!any) ctx.commit();
      any = true;
    }
    if (!any) throw new BackendError("unusable_output", "empty");
  };
  const run = (chain: FakeBackend[], breaker = new CircuitBreaker(3, 10_000)) =>
    executeWithFallback({ chain, breaker, messages: [{ role: "user", content: "hi" }], maxTokens: 50, clientSignal: new AbortController().signal, consume: consumeAll });

  it("falls back on error and records both attempts with cost", async () => {
    const r = await run([new FakeBackend(cfg("a", "fast"), fail()), new FakeBackend(cfg("b", "degraded"), reply("ok there"))]);
    expect(r.status).toBe("ok");
    expect(r.attempts.map((a) => [a.backend, a.outcome])).toEqual([["a", "error"], ["b", "ok"]]);
    expect(r.attempts[1].costUsd).toBeCloseTo((100 * 1 + 20 * 2) / 1e6);
  });
  it("falls back when the first token is too slow", async () => {
    const r = await run([new FakeBackend(cfg("slow", "fast", { firstTokenTimeoutMs: 50 }), hang), new FakeBackend(cfg("b", "degraded"), reply("ok"))]);
    expect(r.attempts[0].outcome).toBe("timeout_first_token");
    expect(r.attempts[0].usageSource).toBe("estimated");
    expect(r.status).toBe("ok");
  });
  it("does not fall back after the stream is committed", async () => {
    const r = await run([
      new FakeBackend(cfg("mid", "fast", { totalTimeoutMs: 80 }), reply("a b c d e f g h", undefined, 30)),
      new FakeBackend(cfg("b", "degraded"), reply("ok")),
    ]);
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.committed).toBe(true);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0].outcome).toBe("timeout_total");
  });
  it("opens the circuit after repeated failures and skips the backend", async () => {
    const breaker = new CircuitBreaker(2, 10_000);
    const a = new FakeBackend(cfg("a", "fast"), fail());
    const b = new FakeBackend(cfg("b", "degraded"), reply("ok"));
    await run([a, b], breaker);
    await run([a, b], breaker);
    const r = await run([a, b], breaker);
    expect(a.calls).toBe(2);
    expect(r.attempts[0].outcome).toBe("skipped_circuit_open");
  });
});

describe("quota", () => {
  it("admits, reserves, and rejects when the reservation would exceed the quota", () => {
    const db = openDb(":memory:", TENANTS);
    const t = getTenant(db, "tiny")!;
    const a = admit(db, t, { requestId: "r1", endpoint: "x", estimatedPromptTokens: 400, requestedMaxTokens: 500 });
    expect(a.maxCompletionTokens).toBe(500); // 900 - 400
    expect(getUsage(db, t).tokensReserved).toBe(900);
    expect(() => admit(db, t, { requestId: "r2", endpoint: "x", estimatedPromptTokens: 10, requestedMaxTokens: 10 })).toThrow(/token quota exhausted/);
    const row = db.prepare("SELECT outcome, counts_against_quota FROM requests WHERE id='r2'").get() as any;
    expect(row).toEqual({ outcome: "quota_exceeded", counts_against_quota: 0 });
  });
  it("fails closed when the database is unavailable", () => {
    const db = openDb(":memory:", TENANTS);
    const t = getTenant(db, "pro")!;
    db.close();
    try {
      admit(db, t, { requestId: "r", endpoint: "x", estimatedPromptTokens: 1, requestedMaxTokens: 1 });
      expect.unreachable();
    } catch (e: any) {
      expect(e.status).toBe(503);
      expect(e.code).toBe("quota_unavailable");
    }
  });
});
