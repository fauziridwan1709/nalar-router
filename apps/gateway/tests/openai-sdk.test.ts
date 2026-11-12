/**
 * Contract test: the official OpenAI SDK, pointed at the gateway, must work without changes.
 * Scripted backends, so no network; the SDK talks to the gateway over real HTTP.
 */
import OpenAI, { AuthenticationError, BadRequestError } from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { FakeBackend, cfg, reply, startServer } from "./helpers.js";

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function client(key = "k-pro") {
  const s = await startServer([new FakeBackend(cfg("f", "fast"), reply("Hello there"))]);
  close = s.close;
  return new OpenAI({ baseURL: `${s.base}/v1`, apiKey: key, maxRetries: 0 });
}
const messages = [{ role: "user" as const, content: "hi" }];

describe("OpenAI SDK compatibility", () => {
  it("chat.completions.create without stream returns a chat.completion", async () => {
    const c = await client();
    const r = await c.chat.completions.create({ model: "auto", messages });
    expect(r.object).toBe("chat.completion");
    expect(r.choices[0].message.content).toBe("Hello there");
    expect(r.choices[0].finish_reason).toBe("stop");
    expect(r.usage?.total_tokens).toBe(120);
  });

  it("streams chunks, with a usage chunk when stream_options.include_usage is set", async () => {
    const c = await client();
    const stream = await c.chat.completions.create({
      model: "auto",
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = "";
    let usage;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? "";
      if (chunk.usage && !chunk.choices.length) usage = chunk.usage;
    }
    expect(text).toBe("Hello there");
    expect(usage?.total_tokens).toBe(120);
  });

  it("accepts the newer request fields: developer role, text parts, max_completion_tokens, sampling", async () => {
    const c = await client();
    const r = await c.chat.completions.create({
      model: "fast",
      messages: [
        { role: "developer", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
      max_completion_tokens: 64,
      top_p: 0.9,
      stop: ["\n\n"],
      seed: 1,
      user: "end-user-1",
    });
    expect(r.choices[0].message.content).toBe("Hello there");
  });

  it("lists models", async () => {
    const c = await client();
    const ids = (await c.models.list()).data.map((m) => m.id);
    expect(ids).toEqual(["auto", "auto-smart", "auto-cascade", "fast", "f"]);
  });

  it("raises the SDK's typed errors", async () => {
    await expect((await client("nope")).chat.completions.create({ model: "auto", messages })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    await close?.();
    await expect((await client()).chat.completions.create({ model: "auto", messages, n: 2 })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });
});
