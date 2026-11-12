/**
 * The web framework: builds the Express app, applies the HTTP hardening, mounts the controllers,
 * serves the console build, and installs the error presenter. No route logic lives here.
 */
import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { GatewayDeps } from "../../use-cases/deps.js";
import { mountAdmin } from "../../interface-adapters/controllers/http/admin.js";
import { mountApi } from "../../interface-adapters/controllers/http/api.js";
import { mountConsole } from "../../interface-adapters/controllers/http/console.js";
import { securityHeaders } from "../../interface-adapters/controllers/http/security.js";
import type { HttpSettings } from "../../interface-adapters/controllers/http/settings.js";
import { createCapabilityRunner } from "../../interface-adapters/controllers/http/specs.js";
import { notFound, presentError } from "../../interface-adapters/presenters/httpError.js";

export function createApp(deps: GatewayDeps, settings: HttpSettings) {
  const app = express();
  app.disable("x-powered-by");
  // so req.ip / req.secure are the client's when running behind a proxy (Render)
  const tp = settings.auth.trustProxy;
  app.set("trust proxy", /^\d+$/.test(tp) ? Number(tp) : tp === "true" ? true : tp === "false" ? false : tp);
  app.use(securityHeaders(settings));
  app.use(express.json({ limit: "64kb" }));

  const runCapability = createCapabilityRunner(deps);
  mountApi(app, deps, runCapability);
  mountConsole(app, deps, settings, runCapability);
  mountAdmin(app, deps, settings);

  // the console build, with client-side routing falling back to index.html
  const webDist = settings.consoleDist;
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!v1\/|admin\/|api\/|healthz).*/, (_req, res) => {
      res.setHeader("cache-control", "no-cache");
      res.sendFile(resolve(webDist, "index.html"));
    });
  }

  app.use(notFound);
  app.use(presentError);
  return app;
}
