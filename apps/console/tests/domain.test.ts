/** The console's rules, tested as plain functions (no React, no network). */
import { describe, expect, it } from "vitest";
import { fmtMs, fmtN, fmtUsd, pct } from "../src/domain/format";
import { levelOf, sharePct } from "../src/domain/quota";
import { backendState } from "../src/domain/backends";
import { hasPermission } from "../src/domain/access";
import { groupOf } from "../src/domain/outcomes";
import { applyEvent, TRACE_LABEL, type Turn } from "../src/domain/playground";
import { chatSnippet, supportSnippet } from "../src/domain/snippets";
import type { BackendStatus, TenantUsage } from "../src/domain/models";

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
