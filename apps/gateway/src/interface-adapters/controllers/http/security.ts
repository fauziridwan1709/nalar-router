/** HTTP hardening shared by the API and the console: headers, cookies, CSRF and origin checks. */
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { HttpSettings } from "./settings.js";

export const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** strict CSP: the console is one bundle from 'self'; inline style attributes are the only allowance */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function securityHeaders(cfg: HttpSettings) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("content-security-policy", CSP);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cross-origin-opener-policy", "same-origin");
    res.setHeader("cross-origin-resource-policy", "same-origin");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
    if (isSecure(req, cfg)) res.setHeader("strict-transport-security", "max-age=15552000; includeSubDomains");
    // nothing behind the API or the console API may be cached by a browser or a proxy
    if (/^\/(v1|api|admin)\//.test(req.path)) res.setHeader("cache-control", "no-store");
    next();
  };
}

export const isSecure = (req: Request, cfg: HttpSettings) => cfg.auth.forceSecureCookies || req.secure;

/** `__Host-` pins the cookie to this exact host over HTTPS; plain HTTP (local dev) can't use the prefix */
export const sessionCookieName = (req: Request, cfg: HttpSettings) =>
  isSecure(req, cfg) ? "__Host-nalar_sid" : "nalar_sid";

export function readCookie(req: Request, name: string): string | null {
  const header = req.header("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function setSessionCookie(req: Request, res: Response, cfg: HttpSettings, token: string, maxAgeMs: number) {
  const attrs = [
    `${sessionCookieName(req, cfg)}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (isSecure(req, cfg)) attrs.push("Secure");
  res.append("set-cookie", attrs.join("; "));
}

export function clearSessionCookie(req: Request, res: Response, cfg: HttpSettings) {
  res.append(
    "set-cookie",
    `${sessionCookieName(req, cfg)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure(req, cfg) ? "; Secure" : ""}`,
  );
}

/**
 * A cross-site page can't read our CSRF token, and SameSite=Strict already keeps the cookie off
 * cross-site requests; the Origin check is the third layer, for browsers that send one.
 */
export function sameOrigin(req: Request) {
  const origin = req.header("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.header("host");
  } catch {
    return false;
  }
}
