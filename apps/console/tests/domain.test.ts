/** The console's rules, tested as plain functions (no React, no network). */
import { describe, expect, it } from "vitest";
import { fmtMs, fmtN, fmtUsd, pct } from "../src/entities/format";
import { levelOf, sharePct } from "../src/entities/quota";
import { backendState } from "../src/entities/backends";
import { hasPermission } from "../src/entities/access";
import { groupOf } from "../src/entities/outcomes";
import { applyEvent, TRACE_LABEL, type Turn } from "../src/entities/playground";
import { chatSnippet, supportSnippet } from "../src/entities/snippets";
import type { BackendStatus, TenantUsage } from "../src/entities/models";
import { checkPlayground, contextWindowFor, estimateMessagesTokens } from "../src/entities/limits";

describe("format", () => {
  it("formats money, durations, counts and shares", () => {
    expect(fmtUsd(0)).toBe("$0");
    expect(fmtUsd(0.000153)).toBe("$0.000153");
    expect(fmtUsd(1.5)).toBe("$1.5000");
    expect(fmtMs(771)).toBe("771 ms");
    expect(fmtMs(2100)).toBe("2.10 s");
    expect(fmtN(null)).toBe("–");
    expect(pct(0.05)).toBe("5.0%");
    expect(sharePct(0.004)).toBe("<1%");
  });
});

describe("quota standing", () => {
  const u = (o: Partial<TenantUsage>): TenantUsage => ({
    tenant: "t", name: "T", plan: "pro", allowedTiers: [], profileFields: 0, periodStart: 0, periodEnd: 0, tokensUsed: 0, tokensReserved: 0,
    requestsUsed: 0, tokenQuota: 1000, requestQuota: 10, tokensRemaining: 1000, requestsRemaining: 10, costUsd: 0, quotaRejections: 0, rejecting: false,
    outcomes: [], ...o,
  });
  it("is ok under 80%, near from 80%, out at 100%", () => {
    expect(levelOf(u({ tokensRemaining: 500 }))).toBe("ok");
    expect(levelOf(u({ tokensRemaining: 150 }))).toBe("near");
    expect(levelOf(u({ requestsUsed: 10 }))).toBe("out");
  });
  it("is out as soon as the newest request was refused, even below 100%", () => {
    expect(levelOf(u({ tokensRemaining: 805, rejecting: true }))).toBe("out");
  });
});

describe("backend status", () => {
  const b = (o: Partial<BackendStatus>): BackendStatus => ({ id: "x", tier: "fast", model: "m", enabled: true, location: "cloud", breaker: { state: "closed" }, ...o });
  it("labels online, offline and degraded (breaker open)", () => {
    expect(backendState(b({ health: { label: "online", availability: "online", checkedAt: 1 } })).label).toBe("online");
    expect(backendState(b({ enabled: false })).label).toBe("offline");
    expect(backendState(b({ health: { label: "online", availability: "online", checkedAt: 1 }, breaker: { state: "open" } }))).toEqual({ label: "degraded", reason: "circuit breaker open" });
  });
});

describe("access and outcomes", () => {
  it("mirrors the gateway's grants for display", () => {
    expect(hasPermission("operator", "chaos:write")).toBe(true);
    expect(hasPermission("viewer", "playground:run")).toBe(false);
    expect(hasPermission("developer", "keys:revoke_any")).toBe(false);
  });
  it("groups outcomes", () => {
    expect(groupOf("success")).toBe("success");
    expect(groupOf("refused_low_confidence")).toBe("refused");
    expect(groupOf("quota_exceeded")).toBe("rejected");
    expect(groupOf("failed_all_backends")).toBe("failed");
  });
});

describe("playground events", () => {
  const turn = (): Turn => ({
    id: 1, endpoint: "support", stream: true, raw: "", question: "q", tenant: "acme", answer: "", attempts: [], reasoning: [], trace: [], streaming: true,
    settings: { model: "auto", prompt_version: "v3", include_reasoning: false },
  });
  const run = (events: [string, any][]) => events.reduce((t, [ev, d]) => applyEvent(t, ev, d), turn());

  it("builds the answer, keeps the latest status per attempt, and closes on done", () => {
    const t = run([
      ["meta", { requestId: "req_1", t: 0 }],
      ["attempt", { seq: 1, backend: "groq-strong", status: "started", t: 1 }],
      ["attempt", { seq: 1, backend: "groq-strong", status: "unusable_output", t: 900 }],
      ["attempt", { seq: 2, backend: "groq-fast", status: "started", t: 901 }],
      ["token", { text: "Hel" }],
      ["token", { text: "lo" }],
      ["done", { outcome: "success", t: 1500 }],
    ]);
    expect(t.answer).toBe("Hello");
    expect(t.attempts.map((a) => [a.seq, a.status])).toEqual([[1, "unusable_output"], [2, "started"]]);
    expect(t.streaming).toBe(false);
    expect(t.trace.map((x) => x.event)).toEqual(["meta", "attempt", "attempt", "attempt", "done"]); // tokens aren't traced
  });
  it("joins reasoning per attempt", () => {
    const t = run([["reasoning", { seq: 1, backend: "a", text: "x" }], ["reasoning", { seq: 1, backend: "a", text: "y" }], ["reasoning", { seq: 2, backend: "b", text: "z" }]]);
    expect(t.reasoning).toEqual([{ seq: 1, backend: "a", text: "xy" }, { seq: 2, backend: "b", text: "z" }]);
  });
  it("puts the first token on the trace at the gateway's time to first token, and the total on done", () => {
    const t = run([
      ["meta", { t: 0 }],
      ["intent", { intent: "cancel_order", confidence: 0.9, label: "high", t: 400 }],
      ["done", { outcome: "success", backend: "groq-fast", ttftMs: 420, latencyMs: 1500, usage: { totalTokens: 900 }, costUsd: 0.0001, t: 1500 }],
    ]);
    expect(t.trace.map((x) => [x.event, x.t])).toEqual([["meta", 0], ["intent", 400], ["first_token", 420], ["done", 1500]]);
    expect(TRACE_LABEL.first_token(t.trace[2].data)).toBe("first token from groq-fast: time to first token 420 ms");
    expect(TRACE_LABEL.done(t.trace[3].data)).toMatch(/^response complete in 1\.50 s \(first token at 420 ms\); metered: success/);
  });
  it("adds no first-token line when no token was sent (a refusal)", () => {
    const t = run([["refusal", { reason: "low_confidence", t: 300 }], ["done", { outcome: "refused_low_confidence", ttftMs: null, latencyMs: 310, t: 310 }]]);
    expect(t.trace.map((x) => x.event)).toEqual(["refusal", "done"]);
  });
  it("describes trace events in words", () => {
    expect(TRACE_LABEL.route({ rule: "auto_escalate_strong", chain: ["groq-strong", "groq-fast"] })).toBe("routed by auto_escalate_strong: groq-strong › groq-fast");
  });
});

describe("code snippets", () => {
  it("follow the stream setting", () => {
    expect(supportSnippet("curl", "https://x", { message: "hi", stream: true })).toContain("curl -N");
    expect(supportSnippet("curl", "https://x", { message: "hi", stream: false })).not.toContain("curl -N");
    expect(chatSnippet("python", "https://x", { messages: [{ role: "user", content: "hi" }], stream: false })).toContain("stream=False");
  });
  it("never embed a key", () => {
    expect(chatSnippet("node", "https://x")).toContain("process.env.NALAR_API_KEY");
  });
});

describe("request limits", () => {
  const limits = {
    supportMessageChars: 2_000, chatMessageChars: 16_000, chatTotalChars: 32_000, chatMaxMessages: 50,
    maxCompletionTokens: 4_096, chatDefaultCompletionTokens: 1_024, supportAnswerTokens: 800, supportReasoningExtraTokens: 1_200,
  };
  const b = (id: string, tier: string, contextWindow: number | null, enabled = true) => ({ id, tier, model: id, location: "cloud", enabled, contextWindow });
  const backends = [b("fast", "fast", 131_072), b("local", "local", 8_192), b("mock", "degraded", null), b("off", "strong", 1_000, false)];
  const cfg = { backends, limits };
  const input = { endpoint: "chat" as const, message: "hi", system: "", model: "local", includeReasoning: false };

  it("estimates tokens the way the gateway does", () => {
    expect(estimateMessagesTokens([{ content: "abcd" }, { content: "abcde" }])).toBe(2 + 4 + 1 + 4 + 2);
  });

  it("a pinned model is checked against its own window; auto against the largest the plan allows", () => {
    expect(contextWindowFor("local", backends, ["fast", "local"]).window).toBe(8_192);
    expect(contextWindowFor("auto", backends, ["fast", "local"])).toEqual({ window: 131_072, label: "fast" });
    expect(contextWindowFor("auto", backends, ["fast", "degraded"]).window).toBeNull(); // the mock has no limit
    expect(contextWindowFor("strong", backends, ["strong"]).window).toBeNull(); // nothing enabled: the gateway decides
  });

  it("blocks a chat request that doesn't fit the pinned model, and says by how much", () => {
    const long = "x".repeat(30_000); // 7,500 tokens + 1,024 for the answer > 8,192
    const c = checkPlayground({ ...input, message: long.slice(0, 16_000), system: long.slice(0, 14_000) }, cfg, ["fast", "local"]);
    expect(c.problems).toHaveLength(1);
    expect(c.problems[0]).toContain('"local" accepts up to 8,192 tokens');
    expect(checkPlayground({ ...input, message: long.slice(0, 16_000), system: long.slice(0, 14_000), model: "auto" }, cfg, ["fast", "local"]).problems).toEqual([]);
  });

  it("enforces the API's character limits per field and in total", () => {
    expect(checkPlayground({ ...input, endpoint: "support", message: "x".repeat(2_001), model: "auto" }, cfg, ["fast"]).problems[0]).toContain("2,000 characters");
    const c = checkPlayground({ ...input, model: "fast", message: "x".repeat(16_001), system: "y".repeat(16_000) }, cfg, ["fast"]);
    expect(c.problems).toEqual([
      "The user message is limited to 16,000 characters.",
      "System prompt and message together are limited to 32,000 characters (now 32,001).",
    ]);
  });

  it("support reserves the answer budget, more with reasoning on", () => {
    const s = (includeReasoning: boolean) => checkPlayground({ ...input, endpoint: "support", message: "hi", includeReasoning }, cfg, ["local"]);
    expect(s(false).completionTokens).toBe(800);
    expect(s(true).completionTokens).toBe(2_000);
  });
});
