/**
 * Process entry point: build the gateway, serve HTTP, and shut down cleanly.
 *
 * Failure handling at the process level:
 * - the port can't be bound (EADDRINUSE…): say so and exit 1, instead of a bare stack trace
 * - an uncaught exception or unhandled rejection: log it, stop accepting connections, give
 *   in-flight requests up to 10 s to finish, then exit 1 so the platform restarts a clean process
 *   (state after an unknown failure can't be trusted, and quota correctness depends on it)
 * - SIGTERM / SIGINT (deploys, Ctrl-C): the same drain, exit 0
 */
import { config } from "./config.js";
import { createGateway } from "./gateway.js";
import { createApp } from "./interfaces/http/app.js";

const gw = createGateway(config);
const app = createApp(gw);
gw.health.start();
// Express 5 also calls this callback when listening fails; that case is handled by server.on("error")
const server = app.listen(config.port, (err?: Error) => {
  if (err) return;
  const enabled = gw.backends.filter((b) => b.config.enabled).map((b) => `${b.config.id}(${b.config.model})`);
  console.log(`nalar-router on :${config.port} | backends: ${enabled.join(", ")} | KB ${gw.kb.entries.length} entries | demo=${config.demoMode}`);
});
server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(
    err.code === "EADDRINUSE" ? `port ${config.port} is already in use; stop the other process or set PORT` : "server failed to start",
    err.code === "EADDRINUSE" ? "" : err,
  );
  process.exit(1);
});
// streaming responses can legitimately be long; don't let Node cut them
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 61_000;

let shuttingDown = false;
function shutdown(reason: string, code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`shutting down (${reason}); draining in-flight requests`);
  gw.health.stop();
  server.close(() => {
    try {
      gw.db.close();
    } catch (e) {
      console.error("closing the database failed", e);
    }
    process.exit(code);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(code), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("uncaughtException", (err) => {
  console.error("uncaught exception", err);
  shutdown("uncaught exception", 1);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandled promise rejection", reason);
  shutdown("unhandled rejection", 1);
});
