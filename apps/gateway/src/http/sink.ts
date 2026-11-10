import type { Response } from "express";

export interface EventSink {
  emit(event: string, data: unknown): void;
}

/** Server-Sent Events over a POST response. */
const stamp = (event: string, data: unknown, start: number) =>
  event === "token" || event === "reasoning" || typeof data !== "object" || data === null || Array.isArray(data)
    ? data
    : { ...(data as object), t: Date.now() - start };

export class SseSink implements EventSink {
  private heartbeat: NodeJS.Timeout;
  private start = Date.now();
  constructor(private res: Response) {
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no"); // disable proxy buffering (nginx/Render)
    res.flushHeaders();
    // keep idle connections alive through proxies while a slow backend thinks
    this.heartbeat = setInterval(() => this.write(": ping\n\n"), 15_000);
  }
  private write(s: string) {
    if (!this.res.writableEnded && !this.res.destroyed) this.res.write(s);
  }
  emit(event: string, data: unknown) {
    this.write(`event: ${event}\ndata: ${JSON.stringify(stamp(event, data, this.start))}\n\n`);
  }
  end() {
    clearInterval(this.heartbeat);
    if (!this.res.writableEnded) this.res.end();
  }
}

/** Collects events for the non-streaming JSON mode. */
export class CollectSink implements EventSink {
  events: { event: string; data: any }[] = [];
  answer = "";
  reasoning: Record<string, string> = {};
  private start = Date.now();
  emit(event: string, data: any) {
    if (event === "token") this.answer += data.text;
    else if (event === "reasoning") this.reasoning[data.backend] = (this.reasoning[data.backend] ?? "") + data.text;
    else this.events.push({ event, data: stamp(event, data, this.start) });
  }
  last(event: string) {
    return [...this.events].reverse().find((e) => e.event === event)?.data;
  }
  all(event: string) {
    return this.events.filter((e) => e.event === event).map((e) => e.data);
  }
}
