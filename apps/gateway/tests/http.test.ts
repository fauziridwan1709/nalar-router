/** End-to-end request path over real HTTP with scripted backends. */
import { afterEach, describe, expect, it } from "vitest";
import { FakeBackend, cfg, fail, hang, reply, signIn, sse, startServer, think } from "./helpers.js";

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

const GOOD = '{"intent":"cancel_order","confidence":0.9}\n###\nGo to Orders and press Cancel.';
const post = (base: string, path: string, key: string | null, body: unknown) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("support endpoint", () => {
  it("rejects missing / invalid keys and invalid input", async () => {
    const s = await startServer([new FakeBackend(cfg("f", "fast"), reply(GOOD))]);
    close = s.close;
    expect((await post(s.base, "/v1/support/answer", null, { message: "x" })).status).toBe(401);
    expect((await post(s.base, "/v1/support/answer", "nope", { message: "x" })).status).toBe(401);
    const bad = await post(s.base, "/v1/support/answer", "k-pro", { message: "" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_request");
    expect((await post(s.base, "/v1/support/answer", "k-pro", "{nope")).status).toBe(400);
    expect((await post(s.base, "/v1/support/answer", "k-pro", { message: "x", extra: 1 })).status).toBe(400);
  });

  it("streams route, retrieval, intent, tokens and a metered done event", async () => {
    const s = await startServer([new FakeBackend(cfg("f", "fast"), reply(GOOD))]);
    close = s.close;
    const res = await post(s.base, "/v1/support/answer", "k-pro", { message: "how do I cancel my order" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const ev = await sse(res);
    const names = ev.map((e) => e.event);
    expect(names.slice(0, 5)).toEqual(["meta", "route", "retrieval", "step", "attempt"]);
    expect(ev[0].data.admission.maxCompletionTokens).toBeGreaterThan(0);
    expect(typeof ev[1].data.t).toBe("number"); // server-side elapsed ms on every non-token event
    expect(names).toContain("intent");
    const answer = ev.filter((e) => e.event === "token").map((e) => e.data.text).join("");
    expect(answer).toBe("Go to Orders and press Cancel.");
    const done = ev.at(-1)!.data;
    expect(done).toMatchObject({ outcome: "success", backend: "f", fallbackUsed: false, intent: "cancel_order" });
    expect(done.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120, source: "provider" });
    expect(done.costUsd).toBeCloseTo(140 / 1e6);
    // persisted
    const row = s.gw.db.prepare("SELECT * FROM requests WHERE id = ?").get(done.requestId) as any;
    expect(row).toMatchObject({ outcome: "success", backend: "f", prompt_tokens: 100, completion_tokens: 20 });
  });

  it("falls back when the model output is unusable and records why", async () => {
    const s = await startServer([
      new FakeBackend(cfg("f", "fast"), reply("Sure! I can help you with that.")),
      new FakeBackend(cfg("m", "degraded"), reply(GOOD)),
    ]);
    close = s.close;
    const r = await (await post(s.base, "/v1/support/answer", "k-pro", { message: "cancel my order", stream: false })).json();
    expect(r.outcome).toBe("success");
    expect(r.backend).toBe("m");
    expect(r.fallbackUsed).toBe(true);
    expect(r.attempts.map((a: any) => a.outcome)).toEqual(["unusable_output", "ok"]);
    const detail = await (await fetch(`${s.base}/admin/requests/${r.requestId}`, { headers: { "x-admin-token": "adm" } })).json();
    expect(detail.attempts).toHaveLength(2);
    expect(detail.route_reason.chain).toEqual(["f", "m"]);
    const list = await (await fetch(`${s.base}/admin/requests`, { headers: { "x-admin-token": "adm" } })).json();
    expect(list.find((x: any) => x.id === r.requestId).attempt_trail).toBe("f:unusable_output,m:ok");
  });

  it("falls back on first-token timeout", async () => {
    const s = await startServer([
      new FakeBackend(cfg("f", "fast", { firstTokenTimeoutMs: 80 }), hang),
      new FakeBackend(cfg("m", "degraded"), reply(GOOD)),
    ]);
    close = s.close;
    const r = await (await post(s.base, "/v1/support/answer", "k-pro", { message: "cancel my order", stream: false })).json();
    expect(r.attempts.map((a: any) => a.outcome)).toEqual(["timeout_first_token", "ok"]);
  });

  it("returns 502 with a clear error when every backend fails", async () => {
    const s = await startServer([new FakeBackend(cfg("f", "fast"), fail()), new FakeBackend(cfg("m", "degraded"), fail())]);
    close = s.close;
    const res = await post(s.base, "/v1/support/answer", "k-pro", { message: "cancel my order", stream: false });
    expect(res.status).toBe(502);
    expect((await res.json()).outcome).toBe("failed_all_backends");
  });

  it("refuses out-of-scope questions without calling a model", async () => {
    const f = new FakeBackend(cfg("f", "fast"), reply(GOOD));
    const s = await startServer([f]);
    close = s.close;
    const r = await (await post(s.base, "/v1/support/answer", "k-pro", { message: "write a poem about the ocean", stream: false })).json();
    expect(r.outcome).toBe("refused_out_of_scope");
    expect(r.refused).toBe(true);
    expect(f.calls).toBe(0);
    expect(r.costUsd).toBe(0);
  });

  it("does not gate long, chatty in-domain messages on lexical coverage (sends them to the model)", async () => {
    const f = new FakeBackend(cfg("f", "fast"), reply(GOOD));
    const s = await startServer([f]);
    close = s.close;
    const r = await (
      await post(s.base, "/v1/support/answer", "k-pro", {
        message: "this is the third time this week, I am honestly furious and exhausted, please just cancel my order",
        stream: false,
      })
    ).json();
    expect(f.calls).toBe(1);
    expect(r.outcome).toBe("success");
  });

  it("refuses when the model disagrees with retrieval and confidence is low", async () => {
    const s = await startServer([new FakeBackend(cfg("f", "fast"), reply('{"intent":"get_refund","confidence":0.1}\n###\nRefund stuff'))]);
    close = s.close;
    const r = await (await post(s.base, "/v1/support/answer", "k-pro", { message: "how do I cancel my order", stream: false })).json();
    expect(r.outcome).toBe("refused_low_confidence");
    expect(r.answer).toMatch(/human agent/);
  });

  it("refuses when the model labels the message unknown", async () => {
    const s = await startServer([new FakeBackend(cfg("f", "fast"), reply('{"intent":"unknown","confidence":0.9}\n###\nI only do support'))]);
    close = s.close;
    const r = await (await post(s.base, "/v1/support/answer", "k-pro", { message: "cancel order poem", stream: false })).json();
    expect(r.outcome).toBe("refused_out_of_scope");
  });

  it("enforces quota: fails closed with 429 and a clear error", async () => {
    const s = await startServer([new FakeBackend(cfg("f", "fast"), reply(GOOD, { promptTokens: 300, completionTokens: 20 }))]);
    close = s.close;
    const first = await post(s.base, "/v1/support/answer", "k-tiny", { message: "cancel my order", stream: false });
    expect(first.status).toBe(200);
    await first.json();
    await (await post(s.base, "/v1/support/answer", "k-tiny", { message: "track my order", stream: false })).json();
    const third = await post(s.base, "/v1/support/answer", "k-tiny", { message: "cancel my order", stream: false });
    expect(third.status).toBe(429);
    const body = await third.json();
    expect(body.error.code).toBe("quota_exceeded");
    expect(third.headers.get("retry-after")).toBeTruthy();
    const usage = await (await fetch(`${s.base}/v1/usage`, { headers: { authorization: "Bearer k-tiny" } })).json();
    expect(usage.requestsUsed).toBe(2);
  });

  it("returns 403 when a tenant asks for a tier outside its plan", async () => {
    const s = await startServer([new FakeBackend(cfg("f", "fast"), reply(GOOD)), new FakeBackend(cfg("s", "strong"), reply(GOOD))]);
    close = s.close;
    const res = await post(s.base, "/v1/support/answer", "k-free", { message: "cancel my order", model: "strong" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("model_not_allowed");
  });
});

describe("placeholders", () => {
  it("fills slots from the message and the tenant profile before streaming; raw mode keeps them", async () => {
    const out = '{"intent":"cancel_order","confidence":0.9}\n###\nCancel order {{Order Number}} at {{Website URL}} or call {{Customer Support Phone Number}}.';
    const s = await startServer([new FakeBackend(cfg("f", "fast"), reply(out))]);
    close = s.close;
    const ev = await sse(await post(s.base, "/v1/support/answer", "k-pro", { message: "how do I cancel my order 98765" }));
    const answer = ev.filter((e) => e.event === "token").map((e) => e.data.text).join("");
    expect(answer).toBe("Cancel order 98765 at pro.example or call +62 21 555 0100.");
    const step = ev.find((e) => e.event === "step" && e.data.name === "placeholders_rendered")!;
    expect(step.data.slots.map((x: any) => x.source)).toEqual(["message", "profile", "profile"]);
    const raw = await (await post(s.base, "/v1/support/answer", "k-pro", { message: "how do I cancel my order 98765", placeholders: "raw", stream: false })).json();
    expect(raw.answer).toContain("{{Order Number}}");
  });
});

describe("reasoning and backend status", () => {
  it("streams reasoning as separate events, never as part of the answer, only when asked", async () => {
    const s = await startServer([new FakeBackend(cfg("f", "fast"), think("check the KB first", GOOD))]);
    close = s.close;
    const on = await sse(await post(s.base, "/v1/support/answer", "k-pro", { message: "cancel my order", include_reasoning: true }));
    const thought = on.filter((e) => e.event === "reasoning").map((e) => e.data.text).join("");
    expect(thought.trim()).toBe("check the KB first");
    expect(on.filter((e) => e.event === "token").map((e) => e.data.text).join("")).toBe("Go to Orders and press Cancel.");
    const off = await sse(await post(s.base, "/v1/support/answer", "k-pro", { message: "cancel my order" }));
    expect(off.some((e) => e.event === "reasoning")).toBe(false);
  });

  it("lists every backend with an online/offline label, including ones not configured on this host", async () => {
    const s = await startServer([
      new FakeBackend(cfg("f", "fast"), reply(GOOD)),
      new FakeBackend(cfg("local", "local", { location: "local", enabled: false }), reply(GOOD)),
      new FakeBackend(cfg("m", "degraded", { kind: "mock", location: "built-in" }), reply(GOOD)),
    ]);
    close = s.close;
    const list = await (await fetch(`${s.base}/v1/backends`, { headers: { authorization: "Bearer k-pro" } })).json();
    const local = list.find((b: any) => b.id === "local");
    expect(local.health).toMatchObject({ label: "offline", availability: "disabled", location: "local" });
    expect(local.health.reason).toMatch(/local machine/);
    expect(list.find((b: any) => b.id === "m").health.label).toBe("online");
    const { call } = await signIn(s.base, "viewer@test.example", "viewer-pass-1");
    const consoleCfg = await (await call("/api/console/config")).json();
    expect(consoleCfg.backends.map((b: any) => b.id)).toContain("local");
  });
});

describe("eval results", () => {
  it("lists committed eval runs as summaries (no per-case rows)", async () => {
    const s = await startServer([new FakeBackend(cfg("f", "fast"), reply("x"))]);
    close = s.close;
    const runs = await (await fetch(`${s.base}/admin/evals`, { headers: { "x-admin-token": "adm" } })).json();
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].configs[0]).toHaveProperty("intentAccuracy");
    expect(runs[0].configs[0]).not.toHaveProperty("rows");
  });
});

describe("chat completions endpoint", () => {
  it("streams OpenAI-compatible chunks with x_router metadata", async () => {
    const s = await startServer([new FakeBackend(cfg("f", "fast"), reply("Hello there"))]);
    close = s.close;
    const res = await post(s.base, "/v1/chat/completions", "k-pro", { messages: [{ role: "user", content: "hi" }] });
    const text = await res.text();
    const datas = text.split("\n\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
    expect(datas.map((d) => d.choices[0].delta.content ?? "").join("")).toBe("Hello there");
    const last = datas.at(-1);
    expect(last.usage.total_tokens).toBe(120);
    expect(last.x_router.backend).toBe("f");
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });
  it("validates messages", async () => {
    const s = await startServer([new FakeBackend(cfg("f", "fast"), reply("x"))]);
    close = s.close;
    const res = await post(s.base, "/v1/chat/completions", "k-pro", { messages: [{ role: "robot", content: "hi" }] });
    expect(res.status).toBe(400);
  });
});
