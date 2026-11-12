/**
 * Error presenter: every failure ends here (Express 5 forwards rejected async handlers too) and
 * leaves in the documented shape; see entities/errors.ts and docs/ERRORS.md. The OpenAI-compatible
 * routes also carry OpenAI's error `type` and `param`, which its SDKs read.
 */
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { GatewayError } from "../../entities/errors.js";
import { zodMessage } from "../controllers/http/specs.js";

/** unknown routes don't echo the method or path back */
export const notFound = (_req: Request, _res: Response, next: NextFunction) =>
  next(new GatewayError(404, "not_found", "Not found."));

export function presentError(err: any, req: Request, res: Response, _next: NextFunction) {
  let ge: GatewayError;
  if (err instanceof GatewayError) ge = err;
  else if (err instanceof ZodError) ge = new GatewayError(400, "invalid_request", zodMessage(err));
  else if (err?.type === "entity.parse.failed")
    ge = new GatewayError(400, "invalid_json", "Request body is not valid JSON.");
  else if (err?.type === "entity.too.large")
    ge = new GatewayError(413, "payload_too_large", "Request body exceeds 64kb.");
  else {
    // log the cause with the request id the client also has; the response says nothing about it
    console.error(`[${res.getHeader("x-request-id") ?? "-"}] unhandled error on ${req.method} ${req.path}`, err);
    ge = new GatewayError(500, "internal_error", "Internal error.");
  }
  if (ge.status >= 500 && ge.code !== "internal_error") {
    console.warn(`[${res.getHeader("x-request-id") ?? "-"}] ${ge.status} ${ge.code} on ${req.method} ${req.path}`);
  }
  if (res.headersSent) {
    // already streaming: end the stream with an error in that stream's own format
    try {
      const body = JSON.stringify(ge.toJSON().error);
      res.write(
        req.path === "/v1/chat/completions"
          ? `data: ${JSON.stringify({ error: ge.toJSON().error })}\n\ndata: [DONE]\n\n`
          : `event: error\ndata: ${body}\n\n`,
      );
      res.end();
    } catch {
      /* the connection is already gone */
    }
    return;
  }
  const resetsAt = ge.details?.resetsAt;
  if (ge.status === 429 && typeof resetsAt === "string") {
    res.setHeader("retry-after", String(Math.max(1, Math.ceil((Date.parse(resetsAt) - Date.now()) / 1000))));
  }
  const retryAfter = ge.details?.retryAfterSeconds;
  if (ge.status === 429 && typeof retryAfter === "number") res.setHeader("retry-after", String(retryAfter));
  const openai = req.path === "/v1/chat/completions" || req.path === "/v1/models";
  const body = ge.toJSON();
  res
    .status(ge.status)
    .json(openai ? { error: { ...body.error, type: openaiErrorType(ge.status), param: null } } : body);
}

function openaiErrorType(status: number) {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}
