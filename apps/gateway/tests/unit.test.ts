import { describe, expect, it } from "vitest";
import { SupportOutputParser, parseHeader } from "../src/domain/support/parser.js";
import { Bm25Index } from "../src/domain/support/retrieval.js";
import { planRoute } from "../src/domain/routing/policy.js";
import { CircuitBreaker } from "../src/domain/routing/breaker.js";
import { executeWithFallback } from "../src/application/executor.js";
import { BackendError } from "../src/domain/errors.js";
import { admit, getUsage } from "../src/infrastructure/db/quota.js";
import { openDb } from "../src/infrastructure/db/db.js";
import { getTenant } from "../src/infrastructure/db/tenants.js";
import { computeMetrics, outcomeGroup } from "../src/infrastructure/db/metrics.js";
import { FakeBackend, KB, TENANTS, cfg, fail, hang, reply } from "./helpers.js";
import { PlaceholderRenderer, buildSlots, extractFromMessage, fillablePlaceholders } from "../src/domain/support/placeholders.js";

const INTENTS = new Set(["cancel_order", "track_order", "get_refund", "unknown"]);
const tenant = (id: string) => {
  const t = TENANTS.find((x) => x.id === id)!;
  return {
    id: t.id, name: t.name, plan: t.plan, allowedTiers: t.allowedTiers, tokenQuota: t.tokenQuota, requestQuota: t.requestQuota,
    quotaResetAt: 0, profile: t.profile ?? {}, piiPolicy: { mode: "mask" as const, types: [] },
  };
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

describe("placeholder rendering", () => {
  const slots = buildSlots("please cancel order #A-12345, refund $49.90", { "Customer Support Phone Number": "+62 21 555 0100" });
  const render = (chunks: string[]) => {
    const r = new PlaceholderRenderer(slots);
    return { text: chunks.map((c) => r.push(c)).join("") + r.flush(), r };
  };

  it("extracts concrete values from the customer's message", () => {
    expect(extractFromMessage("cancel order 12345 please")["Order Number"]).toBe("12345");
    expect(extractFromMessage("I need invoice #00108")["Invoice Number"]).toBe("00108");
    expect(extractFromMessage("switch to the platinum account")["Account Type"]).toBe("platinum");
    expect(extractFromMessage("where is my order?")["Order Number"]).toBeUndefined();
  });

  it("fills from message > profile > UI label > fallback, even when split across chunks", () => {
    const { text, r } = render(["Order {{Ord", "er Number}} will be refunded {{Currency Symbol}}{{Refund Amount}}. Call {", "{Customer Support Phone Number}} or open '{{Online Order Interaction}}' with {{Tracking Number}}."]);
    expect(text).toBe("Order A-12345 will be refunded $49.90. Call +62 21 555 0100 or open 'Orders' with your tracking number.");
    expect(Object.fromEntries(r.report().map((x) => [x.name, x.source]))).toMatchObject({
      "Order Number": "message",
      "Customer Support Phone Number": "profile",
      "Online Order Interaction": "ui_label",
      "Tracking Number": "fallback",
    });
  });

  it("never leaves raw braces and tidies empty substitutions", () => {
    const { text } = render(["Hello {{Salutation}} {{Client Last Name}}, see {{Some Unknown Thing}}."]);
    expect(text).not.toMatch(/\{\{|\}\}/);
    expect(text).toBe("Hello, see some unknown thing.");
  });

  it("maps shortened names to the known slot and avoids doubled determiners in fallbacks", () => {
    expect(render(["call {{Support Phone Number}}"]).text).toBe("call +62 21 555 0100");
    expect(render(["sign in on our {{Online Company Portal Info}} with {{Tracking Number}}"]).text).toBe(
      "sign in on our online account with your tracking number",
    );
  });

  it("reads naturally when the sentence already names an unknown identifier", () => {
    const r = new PlaceholderRenderer(buildSlots("see ETA of my order", {}));
    expect(r.push("ETA for the order number {{Order Number}} is soon, bills from {{Person Name}}.") + r.flush()).toBe(
      "ETA for the order number on file is soon, bills from the person you mentioned.",
    );
  });

  it("uses already-streamed text as context and handles a currency sign before the slot", () => {
    const r = new PlaceholderRenderer(buildSlots("ETA please", {}));
    const out = ["your order with the order ", "number ", "{{Order", " Number}}. Refund of $", "{{", "Refund Amount", "}} is on its way, total $5."]
      .map((c) => r.push(c))
      .join("") + r.flush();
    expect(out).toBe("your order with the order number on file. Refund of the refund amount is on its way, total $5.");
  });

  it("releases text that only looks like an opening brace", () => {
    expect(render(["a { b ", "{{ not closed " + "x".repeat(100)]).text).toContain("{{ not closed");
  });

  it("tells the model only about placeholders that have real values", () => {
    const f = fillablePlaceholders(["{{Order Number}} {{Tracking Number}} {{Customer Support Phone Number}}"], slots);
    // Tracking Number has no value → not offered; the phone number is a core contact the tenant has
    expect(f).toEqual(["Customer Support Phone Number", "Order Number"]);
    expect(fillablePlaceholders([], slots)).toEqual(["Customer Support Phone Number"]);
  });
});

describe("dashboard metrics", () => {
  it("buckets requests by time with outcome groups, latency percentiles and fallback rate", () => {
    const db = openDb(":memory:", TENANTS);
    const now = Date.UTC(2026, 10, 10, 10, 30, 0);
    const ins = db.prepare(
      `INSERT INTO requests (id, tenant_id, endpoint, created_at, outcome, backend, fallback_used, prompt_tokens, completion_tokens, latency_ms, cost_usd)
       VALUES (?, ?, 'support.answer', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run("a", "pro", now - 2 * 60_000, "success", "f", 0, 100, 20, 400, 0.001);
    ins.run("b", "pro", now - 2 * 60_000, "success", "s", 1, 100, 20, 900, 0.002);
    ins.run("c", "free", now - 10 * 60_000, "refused_out_of_scope", null, 0, 0, 0, 1, 0);
    ins.run("d", "free", now - 50 * 60_000, "quota_exceeded", null, 0, 0, 0, 0, 0);
    ins.run("old", "pro", now - 3 * 3_600_000, "success", "f", 0, 1, 1, 1, 1);
    const m = computeMetrics(db, "1h", { now });
    expect(m.buckets).toHaveLength(12);
    expect(m.totals).toMatchObject({ requests: 4, modelCalls: 2, fallbackRate: 0.5, p50: 400, p95: 900 });
    expect(m.totals.outcomes).toEqual({ success: 2, refused: 1, rejected: 1, failed: 0 });
    expect(m.totals.costUsd).toBeCloseTo(0.003);
    expect(m.byTenant[0]).toMatchObject({ tenant: "pro", requests: 2 });
    expect(m.byBackend.map((b) => b.backend).sort()).toEqual(["f", "s"]);
    // the last bucket is the current (partial) one; the two requests 2 min ago sit in the one before
    const at = now - 2 * 60_000;
    expect(m.buckets.find((x) => x.t <= at && at < x.t + m.bucketMs)!.requests).toBe(2);
    expect(m.buckets.at(-1)!.t).toBeLessThanOrEqual(now);
    expect(computeMetrics(db, "1h", { now, tenantId: "free" }).totals.requests).toBe(2);
  });
  it("groups outcomes into four states", () => {
    expect(["success", "refused_low_confidence", "quota_exceeded", "partial"].map(outcomeGroup)).toEqual(["success", "refused", "rejected", "failed"]);
  });
});
