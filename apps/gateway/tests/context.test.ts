/** Context windows: a backend is only tried when the prompt plus the answer budget fit in it. */
import { afterEach, describe, expect, it } from "vitest";
import { GatewayError } from "../src/entities/errors.js";
import { planRoute } from "../src/entities/routing/policy.js";
import type { Tenant } from "../src/entities/types.js";
import { FakeBackend, cfg, reply, sse, startServer } from "./helpers.js";

const opts = {
  longQueryTokens: 60,
  ambiguousVoteShare: 0.6,
  complexityThreshold: 0.5,
  classifierMinConfidence: 0.6,
  cascadeModelConfidenceBelow: 0.7,
};
const pro = { id: "pro", name: "pro", plan: "pro", allowedTiers: ["fast", "strong", "degraded"] } as Tenant;
const small = cfg("f", "fast", { contextWindow: 1_000 });
const big = cfg("s", "strong", { contextWindow: 100_000 });
const backends = [small, big].map((config) => ({ config }));
const plan = (hint: string | undefined, promptTokens: number, completionTokens = 200) =>
  planRoute(backends, pro, { queryTokens: 8, text: "hi", hint, context: { promptTokens, completionTokens } }, opts);
const thrown = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e as GatewayError;
  }
  throw new Error("expected a throw");
};

describe("context windows (planRoute)", () => {
  it("leaves a request that fits everywhere unchanged", () => {
    const p = plan(undefined, 500);
    expect(p.chain.map((b) => b.config.id)).toEqual(["f", "s"]);
    expect(p.reason).not.toContain("context window");
  });

  it("auto skips a backend whose window is too small, and says so", () => {
    const p = plan(undefined, 900);
    expect(p.chain.map((b) => b.config.id)).toEqual(["s"]);
    expect(p.reason).toContain("skipped f (context window too small)");
  });

  it("a pinned model that can't hold the request is a 400, not a silent switch", () => {
    const e = thrown(() => plan("f", 900));
    expect(e.code).toBe("context_length_exceeded");
    expect(e.status).toBe(400);
    expect(e.details).toEqual({ model: "f", contextWindow: 1_000, promptTokens: 900, completionTokens: 200 });
    expect(e.message).toContain("accepts up to 1,000 tokens");
  });

  it("the answer budget counts: max_tokens alone can push a request over", () => {
    expect(plan("f", 500, 400).chain[0].config.id).toBe("f");
    expect(thrown(() => plan("f", 500, 600)).code).toBe("context_length_exceeded");
  });

  it("auto with nothing big enough names the largest window", () => {
    const e = thrown(() => plan(undefined, 200_000));
    expect(e.code).toBe("context_length_exceeded");
    expect(e.details?.model).toBe("s");
    expect(e.details?.contextWindow).toBe(100_000);
  });

  it("a backend without a declared window always fits", () => {
    const p = planRoute(
      [{ config: cfg("m", "degraded") }],
      pro,
      { queryTokens: 1, hint: "m", context: { promptTokens: 10_000_000, completionTokens: 1 } },
      opts,
    );
    expect(p.chain[0].config.id).toBe("m");
  });
});

describe("context windows over HTTP", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());
  const post = (base: string, path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k-pro" },
      body: JSON.stringify(body),
    });

  it("chat: pinning a model too small for the messages is an OpenAI-style 400; no model is called", async () => {
    const f = new FakeBackend(cfg("f", "fast", { contextWindow: 1_000 }), reply("hello"));
    const s = await startServer([f, new FakeBackend(cfg("s", "strong", { contextWindow: 100_000 }), reply("hello"))]);
    close = s.close;
    const long = "word ".repeat(1_000); // ~1,250 tokens
    const res = await post(s.base, "/v1/chat/completions", { model: "f", messages: [{ role: "user", content: long }] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("context_length_exceeded");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.details.contextWindow).toBe(1_000);
    expect(f.calls).toBe(0);
    // metered as a rejected request, not counted against quota
    const row = s.gw.db
      .prepare("SELECT outcome, error_code, counts_against_quota FROM requests ORDER BY created_at DESC LIMIT 1")
      .get() as any;
    expect(row).toEqual({ outcome: "rejected", error_code: "context_length_exceeded", counts_against_quota: 0 });
  });

  it("chat: max_tokens is part of the budget", async () => {
    const s = await startServer([new FakeBackend(cfg("f", "fast", { contextWindow: 1_000 }), reply("hello"))]);
    close = s.close;
    const ok = await post(s.base, "/v1/chat/completions", {
      model: "f",
      max_tokens: 500,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ok.status).toBe(200);
    const over = await post(s.base, "/v1/chat/completions", {
      model: "f",
      max_tokens: 1_000,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(over.status).toBe(400);
    expect((await over.json()).error.code).toBe("context_length_exceeded");
  });

  it("support on auto: a backend too small for the prompt is skipped, and the route says why", async () => {
    const GOOD = '{"intent":"cancel_order","confidence":0.9}\n###\nGo to Orders and press Cancel.';
    const f = new FakeBackend(cfg("f", "fast", { contextWindow: 300 }), reply(GOOD));
    const st = new FakeBackend(cfg("s", "strong", { contextWindow: 100_000 }), reply(GOOD));
    const s = await startServer([f, st]);
    close = s.close;
    const events = await sse(await post(s.base, "/v1/support/answer", { message: "how do I cancel my order" }));
    const route = events.find((e) => e.event === "route")!.data;
    expect(route.chain).toEqual(["s"]);
    expect(route.reason).toContain("skipped f (context window too small)");
    expect(f.calls).toBe(0);
    expect(events.find((e) => e.event === "done")!.data.backend).toBe("s");
  });
});
