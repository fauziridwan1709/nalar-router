/**
 * Incremental parser for the model's "header then answer" output.
 *
 * The header ({"intent":..,"confidence":..} then ###) must be fully received and
 * validated BEFORE any answer text is forwarded to the client. That gives one
 * well-defined commit point: up to it we can still refuse or fall back to another
 * backend; after it we are streaming.
 */
import { BackendError } from "../errors.js";

export interface Header {
  intent: string;
  modelConfidence: number;
}

/** how much text we are willing to buffer while looking for the header */
const MAX_HEADER_CHARS = 600;

export class SupportOutputParser {
  private buf = "";
  private header: Header | null = null;
  private inThink = false;

  constructor(private validIntents: Set<string>) {}

  get hasHeader() {
    return this.header !== null;
  }
  get parsedHeader() {
    return this.header;
  }

  /**
   * Feed a chunk. Returns answer text that is now safe to emit (possibly "").
   * Throws BackendError('unusable_output') if the header is malformed.
   */
  push(chunk: string): string {
    if (this.header) return chunk;
    this.buf += chunk;
    this.stripThinking();
    if (this.inThink) return "";

    const sep = this.buf.indexOf("###");
    if (sep >= 0) {
      this.header = parseHeader(this.buf.slice(0, sep), this.validIntents);
      const rest = this.buf.slice(sep + 3).replace(/^#*\s*\n?/, "").replace(/^\s+/, "");
      this.buf = "";
      return rest;
    }
    if (this.buf.length > MAX_HEADER_CHARS) {
      throw new BackendError("unusable_output", `no header separator within ${MAX_HEADER_CHARS} chars`);
    }
    return "";
  }

  /** Called at end of stream. Accepts a header without ### if the JSON line is valid. */
  end(): string {
    if (this.header) return "";
    this.stripThinking();
    const nl = this.buf.indexOf("\n");
    if (nl > 0) {
      this.header = parseHeader(this.buf.slice(0, nl), this.validIntents);
      const rest = this.buf.slice(nl + 1).trim();
      this.buf = "";
      return rest;
    }
    throw new BackendError("unusable_output", `stream ended without a valid header: ${JSON.stringify(this.buf.slice(0, 120))}`);
  }

  private stripThinking() {
    // some local models emit <think>…</think> even when asked not to
    const open = this.buf.indexOf("<think>");
    if (open >= 0) {
      const close = this.buf.indexOf("</think>", open);
      if (close < 0) {
        this.inThink = true;
        return;
      }
      this.buf = this.buf.slice(0, open) + this.buf.slice(close + 8);
    }
    this.inThink = false;
    this.buf = this.buf.replace(/^\s+/, "");
  }
}

export function parseHeader(raw: string, validIntents: Set<string>): Header {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let obj: any = null;
  if (start >= 0 && end > start) {
    try {
      obj = JSON.parse(text.slice(start, end + 1));
    } catch {
      obj = null;
    }
  }
  if (!obj) {
    // tolerate `intent: cancel_order, confidence: 0.9`
    const m = /intent"?\s*[:=]\s*"?([a-z_]+)"?/i.exec(text);
    const c = /confidence"?\s*[:=]\s*([0-9.]+)/i.exec(text);
    if (m) obj = { intent: m[1], confidence: c ? Number(c[1]) : undefined };
  }
  if (!obj || typeof obj.intent !== "string") {
    throw new BackendError("unusable_output", `header is not valid JSON: ${JSON.stringify(text.slice(0, 120))}`);
  }
  const intent = obj.intent.trim().toLowerCase();
  if (!validIntents.has(intent)) {
    throw new BackendError("unusable_output", `model returned unknown intent label "${intent.slice(0, 40)}"`);
  }
  let conf = Number(obj.confidence);
  if (!Number.isFinite(conf)) conf = 0.5;
  if (conf > 1 && conf <= 100) conf = conf / 100; // "85" → 0.85
  conf = Math.min(1, Math.max(0, conf));
  return { intent, modelConfidence: conf };
}
