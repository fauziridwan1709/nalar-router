/**
 * Mock backend = "extractive degraded mode".
 * For the support capability it streams the best-matching KB answer verbatim (with the
 * retrieval-derived intent), so even when every real model is down the customer gets a
 * grounded answer instead of an error. Latency per token is configurable; failures are
 * injected through the chaos layer like any other backend.
 */
import type { BackendConfig } from "../config.js";
import { estimateMessagesTokens, estimateTokens } from "../tokens.js";
import type { Backend, BackendRequest, StreamChunk } from "./types.js";
import { abortableSleep } from "./chaos.js";

export class MockBackend implements Backend {
  constructor(
    readonly config: BackendConfig,
    private tokenDelayMs = Number(process.env.MOCK_TOKEN_DELAY_MS ?? 15),
  ) {}

  async *stream(req: BackendRequest): AsyncIterable<StreamChunk> {
    const ex = req.hints?.extractive;
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const out = ex
      ? `{"intent":"${ex.intent}","confidence":${ex.confidence.toFixed(2)}}\n###\n${ex.answer}`
      : `[mock backend] No real model was used. You said: "${lastUser.slice(0, 200)}"`;
    if (req.includeReasoning) {
      const why = ex
        ? `Degraded mode: no language model is used. Retrieval's top intent is "${ex.intent}" (vote share ${ex.confidence.toFixed(2)}), so I return that knowledge-base answer verbatim.`
        : "Degraded mode: no language model is available, so I can only echo the request.";
      for (const w of why.match(/\S+\s*/g) ?? []) {
        await abortableSleep(this.tokenDelayMs, req.signal);
        yield { type: "reasoning", text: w };
      }
    }
    const pieces = out.match(/\S+\s*|\s+/g) ?? [out];
    let produced = "";
    for (const p of pieces) {
      if (estimateTokens(produced + p) > req.maxTokens) break;
      await abortableSleep(this.tokenDelayMs, req.signal);
      produced += p;
      yield { type: "text", text: p };
    }
    yield { type: "usage", promptTokens: estimateMessagesTokens(req.messages), completionTokens: estimateTokens(produced) };
  }
}
