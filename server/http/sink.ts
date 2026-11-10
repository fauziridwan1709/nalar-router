import type { Response } from "express";

export interface EventSink {
  emit(event: string, data: unknown): void;
}

/** Server-Sent Events over a POST response. */
export class SseSink implements EventSink {
  private heartbeat: NodeJS.Timeout;
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
    this.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
  emit(event: string, data: any) {
    if (event === "token") this.answer += data.text;
    else this.events.push({ event, data });
  }
  last(event: string) {
    return [...this.events].reverse().find((e) => e.event === event)?.data;
  }
  all(event: string) {
    return this.events.filter((e) => e.event === event).map((e) => e.data);
  }
}
