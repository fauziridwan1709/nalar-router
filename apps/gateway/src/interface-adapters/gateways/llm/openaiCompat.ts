/**
 * Streaming client for any OpenAI-compatible /chat/completions endpoint
 * (Groq, Ollama, OpenRouter, vLLM...). No SDK: one fetch + an SSE line parser,
 * so timeouts/abort/usage handling are explicit.
 */
import type { BackendConfig } from "../../../entities/types.js";
import { BackendError } from "../../../entities/errors.js";
import type { Backend, BackendRequest, StreamChunk } from "../../../use-cases/ports/backend.js";

export class OpenAICompatBackend implements Backend {
  constructor(readonly config: BackendConfig) {}

  async *stream(req: BackendRequest): AsyncIterable<StreamChunk> {
    const body = {
      model: this.config.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.2,
      ...Object.fromEntries(Object.entries(req.sampling ?? {}).filter(([, v]) => v !== undefined)),
      ...(this.config.extraBody ?? {}),
      ...(this.config.reasoningBody
        ? req.includeReasoning
          ? this.config.reasoningBody.on
          : this.config.reasoningBody.off
        : {}),
    };
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey ?? ""}`,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal.aborted) throw err;
      throw new BackendError("error", `connect failed: ${(err as Error).message}`);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      // every non-2xx is retryable on *another* backend (429 rate limit, 5xx, even 401 misconfig)
      throw new BackendError("http", `HTTP ${res.status}: ${text.slice(0, 300)}`, true, res.status);
    }

    const decoder = new TextDecoder();
    let buf = "";
    let sawUsage = false;
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(part, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue; // tolerate keep-alives / partial junk lines
        }
        if (json.error) throw new BackendError("error", `provider error: ${JSON.stringify(json.error).slice(0, 300)}`);
        const delta = json.choices?.[0]?.delta;
        // Groq gpt-oss and mlx_lm use `reasoning`; vLLM/DeepSeek-style servers use `reasoning_content`
        const thought = delta?.reasoning ?? delta?.reasoning_content;
        if (typeof thought === "string" && thought.length) yield { type: "reasoning", text: thought };
        const text = delta?.content;
        if (typeof text === "string" && text.length) yield { type: "text", text };
        const usage = json.usage ?? json.x_groq?.usage;
        if (usage && !sawUsage && typeof usage.prompt_tokens === "number") {
          sawUsage = true;
          yield { type: "usage", promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens ?? 0 };
        }
      }
    }
  }
}
