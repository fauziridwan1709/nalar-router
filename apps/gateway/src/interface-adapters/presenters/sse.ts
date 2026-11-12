import type { Response } from "express";
import { stamp, type StreamingSink } from "../../use-cases/ports/sink.js";

/** Server-Sent Events over a POST response. */
export class SseSink implements StreamingSink {
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

