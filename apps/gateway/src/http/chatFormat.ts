/** OpenAI-compatible wire format for /v1/chat/completions, plus an `x_router` block. */
import type { Response } from "express";
import type { CollectSink, EventSink } from "./sink.js";

export class ChatSseSink implements EventSink {
  private id = "";
  private model = "";
  private heartbeat: NodeJS.Timeout;
  private trace: unknown[] = [];
  constructor(private res: Response) {
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();
    this.heartbeat = setInterval(() => this.write(": ping\n\n"), 15_000);
  }
  private write(s: string) {
    if (!this.res.writableEnded && !this.res.destroyed) this.res.write(s);
  }
  private chunk(delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) {
    this.write(
      `data: ${JSON.stringify({
        id: this.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: this.model,
        choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
      })}\n\n`,
    );
  }
  emit(event: string, data: any) {
    switch (event) {
      case "meta":
        this.id = data.requestId;
        break;
      case "model":
        this.model = data.model;
        this.chunk({ role: "assistant" }, null);
        break;
      case "token":
        this.chunk({ content: data.text }, null);
        break;
      case "reasoning":
        this.chunk({ reasoning: data.text }, null, { x_router_backend: data.backend });
        break;
      case "error":
        this.write(`data: ${JSON.stringify({ error: data })}\n\n`);
        break;
      case "done":
        this.chunk({}, data.outcome === "success" ? "stop" : "error", {
          usage: data.usage && {
            prompt_tokens: data.usage.promptTokens, completion_tokens: data.usage.completionTokens, total_tokens: data.usage.totalTokens,
          },
          x_router: { ...data, trace: this.trace },
        });
        this.write("data: [DONE]\n\n");
        break;
      default:
        // route / attempt events: kept for x_router.trace and as SSE comments (ignored by OpenAI clients)
        this.trace.push({ event, ...data });
        this.write(`: ${event} ${JSON.stringify(data)}\n\n`);
    }
  }
  end() {
    clearInterval(this.heartbeat);
    if (!this.res.writableEnded) this.res.end();
  }
}

export function chatCompletionJson(s: CollectSink, done: any) {
  const err = s.last("error");
  return {
    id: done.requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: done.model,
    choices: [{ index: 0, message: { role: "assistant", content: s.answer }, finish_reason: done.outcome === "success" ? "stop" : "error" }],
    usage: done.usage && {
      prompt_tokens: done.usage.promptTokens, completion_tokens: done.usage.completionTokens, total_tokens: done.usage.totalTokens,
    },
    ...(err ? { error: err } : {}),
    x_router: {
      ...done,
      route: s.last("route"),
      attempts: s.all("attempt").filter((a: any) => a.status !== "started"),
      ...(Object.keys(s.reasoning).length ? { reasoning: s.reasoning } : {}),
    },
  };
}
