/**
 * Where a use case reports progress: route, retrieval, attempt, token, done… The HTTP layer
 * provides streaming sinks (support SSE, OpenAI chunks); CollectSink gathers the same events
 * for a single JSON response. Use cases don't know which one they're writing to.
 */
export interface EventSink {
  emit(event: string, data: unknown): void;
}

/** a sink backed by an open connection, closed once the request is metered */
export interface StreamingSink extends EventSink {
  end(): void;
}

/** adds `t` (ms since the request started) to structured events; tokens stay small */
export const stamp = (event: string, data: unknown, start: number) =>
  event === "token" || event === "reasoning" || typeof data !== "object" || data === null || Array.isArray(data)
    ? data
    : { ...(data as object), t: Date.now() - start };

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
