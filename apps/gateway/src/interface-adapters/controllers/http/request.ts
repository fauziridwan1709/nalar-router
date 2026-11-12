/** What the auth middleware attaches to an Express request, and how a credential is read from it. */
import type { Request } from "express";
import type { ApiKey } from "../../../entities/auth/apiKey.js";
import type { User } from "../../../entities/auth/user.js";
import type { Tenant } from "../../../entities/types.js";
import type { Actor } from "../../../use-cases/access.js";

declare module "express-serve-static-core" {
  interface Request {
    tenant?: Tenant;
    apiKey?: ApiKey;
    user?: User;
    csrf?: string;
  }
}

/** `Authorization: Bearer <key>`, or `x-api-key` */
export function bearer(req: Request): string | null {
  const h = req.header("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return req.header("x-api-key")?.trim() || null;
}

/** the signed-in console user behind a request, for use cases that audit */
export const actorOf = (req: Request): Actor => ({ user: req.user!, ip: req.ip });

/** `?tenant=` as a string, or "" */
export const askedTenant = (req: Request) => (typeof req.query.tenant === "string" ? req.query.tenant : "");
