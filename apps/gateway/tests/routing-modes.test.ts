/** The three auto modes: auto (heuristic), auto-smart (classifier) and auto-cascade (fast first, escalate on doubt). */
import { afterEach, describe, expect, it } from "vitest";
import { planRoute } from "../src/entities/routing/policy.js";
import { buildClassifierMessages, parseVerdict, type ClassifierResult } from "../src/entities/routing/classifier.js";
import { cascadeEscalation } from "../src/entities/routing/cascade.js";
import { summarize, type AttemptRecord } from "../src/entities/metering.js";
import type { Tenant } from "../src/entities/types.js";
import { FakeBackend, cfg, hang, reply, sse, startServer, withClassifier } from "./helpers.js";

const opts = {
  longQueryTokens: 60,
  ambiguousVoteShare: 0.6,
  complexityThreshold: 0.5,
  classifierMinConfidence: 0.6,
  cascadeModelConfidenceBelow: 0.7,
};
const tenant = (plan: "pro" | "free"): Tenant =>
  ({
    id: plan,
    name: plan,
    plan,
    allowedTiers: plan === "pro" ? ["fast", "strong", "degraded"] : ["fast", "degraded"],
  }) as Tenant;
const backends = [cfg("f", "fast"), cfg("s", "strong"), cfg("m", "degraded")].map((config) => ({ config }));
const ok = (label: "simple" | "complex", confidence = 0.9): ClassifierResult => ({
  status: "ok",
  backend: "f",
  latencyMs: 5,
  label,
  confidence,
  why: "test",
});
const smart = (over: object = {}, t: "pro" | "free" = "pro") =>
  planRoute(
    backends,
    tenant(t),
    { queryTokens: 8, text: "why was I charged twice", retrievalTopShare: 1, hint: "auto-smart", ...over },
    opts,
  );

describe("auto-smart routing (planRoute)", () => {
  it("is provisional until the classifier runs", () => {
    const p = smart();
    expect(p).toMatchObject({ rule: "smart_pending", mode: "smart", needsClassifier: true });
  });
  it("follows a confident verdict", () => {
    const hard = smart({ classifier: ok("complex") });
    expect(hard.rule).toBe("smart_escalate_strong");
    expect(hard.chain[0].config.id).toBe("s");
    expect(hard.needsClassifier).toBeUndefined();
    expect(hard.reason).toContain('classifier says complex (0.9, "test")');
    const easy = smart({ classifier: ok("simple") });
    expect(easy.rule).toBe("smart_default_fast");
    expect(easy.chain.map((b) => b.config.id)).toEqual(["f", "s", "m"]);
  });
  it("can keep a long but simple message on fast, which the heuristic would escalate", () => {
    const long = { queryTokens: 200, text: "x ".repeat(400) };
    expect(planRoute(backends, tenant("pro"), { ...long, retrievalTopShare: 1 }, opts).rule).toBe(
      "auto_escalate_strong",
    );
    expect(smart({ ...long, classifier: ok("simple") }).rule).toBe("smart_default_fast");
  });
  it("still escalates on ambiguous retrieval, which the classifier can't see", () => {
    const p = smart({ retrievalTopShare: 0.3, classifier: ok("simple") });
    expect(p.rule).toBe("smart_escalate_strong");
    expect(p.reason).toContain("ambiguous_intent");
  });
  it("lets the heuristic decide when the classifier fails or is unsure", () => {
    const failed = smart({ classifier: { status: "failed", error: "timeout" } });
    expect(failed.rule).toBe("smart_fallback_heuristic");
    expect(failed.reason).toMatch(/^classifier failed \(timeout\), so the heuristic decided: simple enough/);
    const unsure = smart({ classifier: ok("complex", 0.4) });
    expect(unsure.rule).toBe("smart_fallback_heuristic");
    expect(unsure.chain[0].config.id).toBe("f");
  });
  it("skips the classifier when the plan has no strong tier to escalate to", () => {
    const p = smart({}, "free");
    expect(p.needsClassifier).toBeUndefined();
    expect(p.rule).toBe("smart_default_fast");
  });
});

describe("auto-cascade routing (planRoute)", () => {
  const cascade = (over: object = {}, t: "pro" | "free" = "pro") =>
    planRoute(
      backends,
      tenant(t),
      { queryTokens: 200, text: "long", retrievalTopShare: 1, hint: "auto-cascade", cascadeCapable: true, ...over },
      opts,
    );
  it("always starts on fast, even for a message the heuristic would escalate", () => {
    const p = cascade();
    expect(p).toMatchObject({ rule: "cascade_start_fast", mode: "cascade" });
    expect(p.reason).toContain("rates itself below 0.7");
    expect(p.chain.map((b) => b.config.id)).toEqual(["f", "s", "m"]);
  });
  it("falls back to the heuristic where there is no header to judge (chat)", () => {
    const p = cascade({ cascadeCapable: false });
    expect(p.mode).toBe("heuristic");
    expect(p.rule).toBe("auto_escalate_strong");
    expect(p.reason).toMatch(/^auto-cascade needs the support header/);
  });
  it("stays on fast when the plan has no strong tier", () => {
    const p = cascade({ queryTokens: 5 }, "free");
    expect(p.rule).toBe("cascade_default_fast");
  });
});

describe("classifier verdicts and cascade escalation (pure)", () => {
  it("parses a verdict, tolerating text around the JSON", () => {
    expect(parseVerdict('{"label":"complex","confidence":0.92,"why":"needs reasoning"}')).toEqual({
      label: "complex",
      confidence: 0.92,
      why: "needs reasoning",
    });
    expect(parseVerdict('Sure: {"label":"Simple","confidence":7} done')).toEqual({
      label: "simple",
      confidence: 1,
      why: "",
    });
    expect(parseVerdict('{"label":"simple","why":"a {b} c"}')).toBeNull(); // the first {...} is not valid JSON
    expect(parseVerdict('{"label":"medium","confidence":0.9}')).toBeNull();
    expect(parseVerdict("no json")).toBeNull();
  });
  it("fences the message as data and truncates very long ones", () => {
    const m = buildClassifierMessages("y".repeat(5000));
    expect(m[0].role).toBe("system");
    expect(m[1].content).toContain("<<<\n");
    expect(m[1].content.length).toBeLessThan(2100);
  });
  const base = {
    intent: "cancel_order",
    modelConfidence: 0.95,
    confidence: 0.68,
    ceiling: 0.69,
    topIntent: "cancel_order",
    refuseBelow: 0.5,
    modelConfidenceBelow: 0.7,
  };
  it("doesn't escalate when the low score is retrieval's, not the model's", () => {
    // live run: agreeing with retrieval at 0.684 when 0.686 was the best possible; strong can't help
    expect(cascadeEscalation(base)).toBeNull();
  });
  it("escalates on the fast model's own doubt", () => {
    expect(cascadeEscalation({ ...base, modelConfidence: 0.5 })).toBe("fast model's own confidence 0.5 < 0.7");
    expect(cascadeEscalation({ ...base, intent: "unknown" })).toMatch(/^fast model said the message is out of scope/);
  });
  it("escalates a disagreement only if it would be refused and agreeing could pass", () => {
    const disagree = { ...base, intent: "get_refund", confidence: 0.3, ceiling: 0.79 };
    expect(cascadeEscalation(disagree)).toMatch(
      /^fast model said get_refund, retrieval says cancel_order, so it would be refused/,
    );
    expect(cascadeEscalation({ ...disagree, confidence: 0.55 })).toBeNull(); // answered anyway: keep it
  });
  it("never escalates when even a perfect answer would be refused", () => {
    expect(cascadeEscalation({ ...base, intent: "unknown", ceiling: 0.45 })).toBeNull();
    expect(cascadeEscalation({ ...base, modelConfidence: 0.1, ceiling: 0.45 })).toBeNull();
  });
  it("doesn't count classification or a cascade escalation as fallback", () => {
    const a = (outcome: AttemptRecord["outcome"]): AttemptRecord => ({
      seq: 0,
      backend: "x",
      model: "x",
      startedAt: 0,
      outcome,
      latencyMs: 1,
      promptTokens: 1,
      completionTokens: 1,
      usageSource: "provider",
      costUsd: 0,
    });
    expect(summarize([a("classified"), a("ok")]).fallbackUsed).toBe(false);
    expect(summarize([a("escalated"), a("ok")]).fallbackUsed).toBe(false);
    expect(summarize([a("classified"), a("escalated"), a("unusable_output"), a("ok")]).fallbackUsed).toBe(true);
  });
});

// ---------------------------------------------------------------- over HTTP

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});
const post = (base: string, path: string, key: string, body: unknown) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
const support = async (base: string, model: string, message = "how do I cancel my order", key = "k-pro") =>
  (await post(base, "/v1/support/answer", key, { message, model, stream: false })).json();
const detail = async (base: string, id: string) =>
  (await fetch(`${base}/admin/requests/${id}`, { headers: { "x-admin-token": "adm" } })).json();

const CONFIDENT = '{"intent":"cancel_order","confidence":0.95}\n###\nGo to Orders and press Cancel.';
const WRONG = '{"intent":"get_refund","confidence":0.4}\n###\nRequest a refund.';
const verdict = (label: string, confidence = 0.9) =>
  reply(JSON.stringify({ label, confidence, why: "test" }), { promptTokens: 200, completionTokens: 40 });

describe("auto-smart over HTTP", () => {
  it("classifies on the fast backend, meters it as attempt 0 and starts where the verdict says", async () => {
    const fast = new FakeBackend(cfg("f", "fast"), withClassifier(verdict("complex"), reply(CONFIDENT)));
    const strong = new FakeBackend(cfg("s", "strong"), reply(CONFIDENT));
    const s = await startServer([fast, strong]);
    close = s.close;
    const r = await support(s.base, "auto-smart");
    expect(r).toMatchObject({ outcome: "success", backend: "s", fallbackUsed: false });
    expect(r.attempts.map((a: any) => [a.seq, a.backend, a.outcome])).toEqual([
      [0, "f", "classified"],
      [1, "s", "ok"],
    ]);
    expect(fast.calls).toBe(1);
    expect(fast.seen[0].temperature).toBe(0);
    // classifier tokens count: 200 + 40 on f, 100 + 20 on s
    expect(r.usage.totalTokens).toBe(360);
    expect(r.costUsd).toBeCloseTo((200 * 1 + 40 * 2 + 100 * 1 + 20 * 2) / 1e6);
    const d = await detail(s.base, r.requestId);
    expect(d.route_reason).toMatchObject({ rule: "smart_escalate_strong", mode: "smart" });
    expect(d.route_reason.signals.classifier).toMatchObject({ status: "ok", label: "complex", backend: "f" });
    expect(d.attempts.map((a: any) => a.outcome)).toEqual(["classified", "ok"]);
  });

  it("streams the classification before the route", async () => {
    const fast = new FakeBackend(cfg("f", "fast"), withClassifier(verdict("simple"), reply(CONFIDENT)));
    const s = await startServer([fast, new FakeBackend(cfg("s", "strong"), reply(CONFIDENT))]);
    close = s.close;
    const ev = await sse(
      await post(s.base, "/v1/support/answer", "k-pro", { message: "how do I cancel my order", model: "auto-smart" }),
    );
    const names = ev.map((e) => (e.event === "step" ? `step:${e.data.name}` : e.event));
    expect(names.filter((n) => n !== "token").slice(0, 7)).toEqual([
      "meta",
      "step:pii_guard",
      "retrieval",
      "step:scope_gate",
      "step:route_classified",
      "attempt",
      "route",
    ]);
    expect(ev.find((e) => e.event === "route")!.data.rule).toBe("smart_default_fast");
    expect(ev.at(-1)!.data).toMatchObject({ outcome: "success", backend: "f" });
  });

  it("falls back to the heuristic on an unparseable verdict or a timeout, and never fails the request", async () => {
    const garbled = new FakeBackend(
      cfg("f", "fast"),
      withClassifier(reply("I think it is complex."), reply(CONFIDENT)),
    );
    let s = await startServer([garbled, new FakeBackend(cfg("s", "strong"), reply(CONFIDENT))]);
    let r = await support(s.base, "auto-smart");
    expect(r).toMatchObject({ outcome: "success", backend: "f" });
    expect((await detail(s.base, r.requestId)).route_reason.rule).toBe("smart_fallback_heuristic");
    await s.close();

    const slow = new FakeBackend(cfg("f", "fast"), withClassifier(hang, reply(CONFIDENT)));
    s = await startServer([slow, new FakeBackend(cfg("s", "strong"), reply(CONFIDENT))], {
      classifier: { timeoutMs: 60 },
    });
    close = s.close;
    r = await support(s.base, "auto-smart");
    expect(r).toMatchObject({ outcome: "success", backend: "f" });
    const d = await detail(s.base, r.requestId);
    expect(d.route_reason.reason).toMatch(/^classifier failed \(no verdict within 60 ms\)/);
    expect(d.attempts[0]).toMatchObject({ outcome: "classified", usage_source: "estimated" });
    // a classifier timeout must not open the fast backend's breaker
    expect(s.gw.breaker.isOpen("f")).toBe(false);
  });

  it("makes no classifier call for a message the scope gate refuses", async () => {
    const fast = new FakeBackend(cfg("f", "fast"), withClassifier(verdict("complex"), reply(CONFIDENT)));
    const s = await startServer([fast, new FakeBackend(cfg("s", "strong"), reply(CONFIDENT))]);
    close = s.close;
    const r = await support(s.base, "auto-smart", "recipe for nasi goreng");
    expect(r.outcome).toBe("refused_out_of_scope");
    expect(fast.calls).toBe(0);
  });

  it("routes chat completions too", async () => {
    const fast = new FakeBackend(cfg("f", "fast"), withClassifier(verdict("complex"), reply("fast answer")));
    const strong = new FakeBackend(cfg("s", "strong"), reply("strong answer"));
    const s = await startServer([fast, strong]);
    close = s.close;
    const r = await (
      await post(s.base, "/v1/chat/completions", "k-pro", {
        model: "auto-smart",
        messages: [{ role: "user", content: "plan my week" }],
      })
    ).json();
    expect(r.choices[0].message.content).toBe("strong answer");
    expect(r.x_router).toMatchObject({ backend: "s", fallbackUsed: false });
    expect(r.x_router.route).toMatchObject({ rule: "smart_escalate_strong", mode: "smart" });
  });
});

describe("auto-cascade over HTTP", () => {
  it("keeps a confident fast answer and never calls strong", async () => {
    const strong = new FakeBackend(cfg("s", "strong"), reply(CONFIDENT));
    const s = await startServer([new FakeBackend(cfg("f", "fast"), reply(CONFIDENT)), strong]);
    close = s.close;
    const r = await support(s.base, "auto-cascade");
    expect(r).toMatchObject({ outcome: "success", backend: "f", fallbackUsed: false });
    expect(strong.calls).toBe(0);
  });

  it("drops an unsure fast attempt before anything is streamed and lets strong answer", async () => {
    const s = await startServer([
      new FakeBackend(cfg("f", "fast"), reply(WRONG)),
      new FakeBackend(cfg("s", "strong"), reply(CONFIDENT)),
    ]);
    close = s.close;
    const ev = await sse(
      await post(s.base, "/v1/support/answer", "k-pro", { message: "how do I cancel my order", model: "auto-cascade" }),
    );
    const answer = ev
      .filter((e) => e.event === "token")
      .map((e) => e.data.text)
      .join("");
    expect(answer).toBe("Go to Orders and press Cancel."); // nothing from the fast model leaked
    const step = ev.find((e) => e.event === "step" && e.data.name === "cascade_escalated")!;
    expect(step.data.detail).toContain("fast model said get_refund, retrieval says cancel_order");
    const done = ev.at(-1)!.data;
    expect(done).toMatchObject({ outcome: "success", backend: "s", fallbackUsed: false, intent: "cancel_order" });
    const d = await detail(s.base, done.requestId);
    expect(d.attempts.map((a: any) => a.outcome)).toEqual(["escalated", "ok"]);
    expect(d.route_reason.rule).toBe("cascade_start_fast");
    expect(s.gw.breaker.isOpen("f")).toBe(false);
  });

  it("doesn't escalate past the plan: without a strong tier the fast model's answer stands or is refused", async () => {
    const s = await startServer([
      new FakeBackend(cfg("f", "fast"), reply(WRONG)),
      new FakeBackend(cfg("s", "strong"), reply(CONFIDENT)),
    ]);
    close = s.close;
    const r = await support(s.base, "auto-cascade", "how do I cancel my order", "k-free");
    expect(r.backend).toBe("f");
    expect(r.attempts.map((a: any) => a.outcome)).not.toContain("escalated");
  });
});
