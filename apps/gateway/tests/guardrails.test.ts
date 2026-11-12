/** PII guardrail: detectors, masking on the way to the model, read-back, block mode, metering, governance API. */
import { afterEach, describe, expect, it } from "vitest";
import { FakeBackend, cfg, reply, signIn, sse, startServer } from "./helpers.js";
import { retrievalText, scanPii } from "../src/domain/guardrails/pii.js";

describe("PII detectors", () => {
  it("masks contact details, cards, IBANs, national ids and IPs", () => {
    const s = scanPii(
      "I'm ana@example.com, call me on +62 812-3456-7890. Card 4111 1111 1111 1111, IBAN GB82 WEST 1234 5698 7654 32, NIK 3171234567890123, from 10.0.0.12",
    );
    expect(s.findings.map((f) => f.type).sort()).toEqual(["card", "email", "iban", "ip_address", "national_id", "phone"]);
    for (const v of ["ana@example.com", "3456", "4111", "GB82", "3171234567890123", "10.0.0.12"]) expect(s.masked).not.toContain(v);
    expect(s.masked).toContain("{{Customer Email}}");
    expect(s.readBack.get("Card Number")).toBe("the card ending in 1111");
    expect(s.readBack.get("Customer Email")).toBe("ana@example.com");
  });

  it("leaves order, invoice and tracking numbers alone", () => {
    for (const msg of ["cancel order 08123456789", "invoice #00108", "tracking number 1Z999AA10123456784", "order 4111111111111112", "where is order 12345?"]) {
      expect(scanPii(msg).findings, msg).toEqual([]);
    }
  });

  it("rejects look-alikes: non-Luhn card numbers, invalid IBANs, out-of-range IPs", () => {
    expect(scanPii("4111 1111 1111 1112").findings).toEqual([]);
    expect(scanPii("GB00 WEST 1234 5698 7654 32").findings).toEqual([]);
    expect(scanPii("version 300.1.2.3").findings).toEqual([]);
  });

  it("drops masked values and their lead-ins from the retrieval text", () => {
    expect(retrievalText(scanPii("how can I cancel my order 48213? you can email me at ana@example.com").masked)).toBe("how can I cancel my order 48213?");
    expect(retrievalText(scanPii("my email is a@b.co, call me on +62 812 3456 7890 about my refund").masked)).toBe(", about my refund");
  });

  it("numbers repeated values once and respects the enabled types", () => {
    const s = scanPii("a@x.io b@y.io a@x.io", ["email"]);
    expect(s.findings.map((f) => f.slot)).toEqual(["Customer Email", "Customer Email 2"]);
    expect(scanPii("a@x.io", ["phone"]).findings).toEqual([]);
  });
});

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});
const post = (base: string, path: string, key: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

describe("PII guardrail on the request path", () => {
  const MSG = "how do I cancel my order 12345? ana@example.com, 4111 1111 1111 1111";
  const ANSWER = '{"intent":"cancel_order","confidence":0.9}\n###\nCancelled. We will email {{Customer Email}} about {{Card Number}}.';

  it("the model never sees the values, the customer reads them back, metering keeps only types", async () => {
    const fake = new FakeBackend(cfg("f", "fast"), reply(ANSWER));
    const s = await startServer([fake]);
    close = s.close;
    const ev = await sse(await post(s.base, "/v1/support/answer", "k-pro", { message: MSG }));
    const sent = JSON.stringify(fake.seen[0].messages);
    expect(sent).not.toContain("ana@example.com");
    expect(sent).not.toContain("4111");
    expect(sent).toContain("{{Customer Email}}");
    expect(sent).toContain("12345"); // the order id is not personal data
    const guard = ev.find((e) => e.event === "step" && e.data.name === "pii_guard")!.data;
    expect(guard.masked.map((m: any) => m.type).sort()).toEqual(["card", "email"]);
    expect(JSON.stringify(ev.filter((e) => e.event !== "token"))).not.toContain("ana@example.com");
    const answer = ev.filter((e) => e.event === "token").map((e) => e.data.text).join("");
    expect(answer).toBe("Cancelled. We will email ana@example.com about the card ending in 1111.");
    const row = s.gw.db.prepare("SELECT pii FROM requests WHERE id = ?").get(ev.at(-1)!.data.requestId) as any;
    expect(row.pii).toBe("email:1,card:1");
  });

  it("block mode rejects before admission and calls no model", async () => {
    const fake = new FakeBackend(cfg("f", "fast"), reply(ANSWER));
    const s = await startServer([fake]);
    close = s.close;
    s.gw.db.prepare(`UPDATE tenants SET pii_policy = '{"mode":"block","types":["email"]}' WHERE id = 'pro'`).run();
    const res = await post(s.base, "/v1/support/answer", "k-pro", { message: MSG, stream: false });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("pii_detected");
    expect(JSON.stringify(body)).not.toContain("ana@example.com");
    expect(fake.calls).toBe(0);
    const row = s.gw.db.prepare("SELECT outcome, pii, counts_against_quota FROM requests WHERE tenant_id = 'pro'").get() as any;
    expect(row).toEqual({ outcome: "rejected", pii: "email:1", counts_against_quota: 0 });
  });

  it("masks every message on the raw chat path", async () => {
    const fake = new FakeBackend(cfg("f", "fast"), reply("ok"));
    const s = await startServer([fake]);
    close = s.close;
    await (await post(s.base, "/v1/chat/completions", "k-pro", { messages: [{ role: "user", content: "my phone is 0812 3456 7890" }], stream: false })).json();
    expect(JSON.stringify(fake.seen[0].messages)).not.toContain("3456");
  });
});

describe("governance API", () => {
  it("owners change the policy (audited), viewers only read it, and the tester stores nothing", async () => {
    const s = await startServer([new FakeBackend(cfg("f", "fast"), reply("x"))]);
    close = s.close;
    const owner = await signIn(s.base, "owner@test.example", "owner-pass-1");
    const g = await (await owner.call("/api/console/governance")).json();
    expect(g.piiPolicy.mode).toBe("mask");
    expect(g.canEdit).toBe(true);
    const put = await owner.call("/api/console/governance/pii", { method: "PUT", json: { mode: "block", types: ["email", "card"] } });
    expect(put.status).toBe(200);
    expect((await put.json()).piiPolicy).toEqual({ mode: "block", types: ["email", "card"] });
    expect((await owner.call("/api/console/governance/pii", { method: "PUT", json: { mode: "mask", types: [] } })).status).toBe(400);
    expect((await owner.call("/api/console/governance/pii", { method: "PUT", json: { mode: "loose", types: [] } })).status).toBe(400);
    const audit = await (await owner.call("/api/console/audit")).json();
    expect(audit.some((a: any) => a.action === "governance.pii_policy")).toBe(true);

    const viewer = await signIn(s.base, "viewer@test.example", "viewer-pass-1");
    expect((await viewer.call("/api/console/governance")).status).toBe(200);
    expect((await viewer.call("/api/console/governance/pii", { method: "PUT", json: { mode: "off", types: [] } })).status).toBe(403);
    expect((await viewer.call("/api/console/members")).status).toBe(403);

    const before = (s.gw.db.prepare("SELECT COUNT(*) AS n FROM requests").get() as any).n;
    const t = await (await owner.call("/api/console/governance/pii/test", { method: "POST", json: { text: "mail me: a@b.co" } })).json();
    expect(t.masked).toBe("mail me: {{Customer Email}}");
    expect((s.gw.db.prepare("SELECT COUNT(*) AS n FROM requests").get() as any).n).toBe(before);
  });

  it("an operator reading another tenant's request leaves an audit entry", async () => {
    const s = await startServer([new FakeBackend(cfg("f", "fast"), reply('{"intent":"cancel_order","confidence":0.9}\n###\nok'))]);
    close = s.close;
    const r = await (await post(s.base, "/v1/support/answer", "k-free", { message: "how do I cancel my order", stream: false })).json();
    const op = await signIn(s.base, "op@test.example", "op-pass-1");
    expect((await op.call(`/api/console/requests/${r.requestId}`)).status).toBe(200);
    const audit = await (await op.call("/api/console/audit")).json();
    expect(audit.find((a: any) => a.action === "data.cross_tenant_read")).toMatchObject({ tenantId: "free", target: r.requestId });
  });
});
