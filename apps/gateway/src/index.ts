import { config } from "./config.js";
import { createGateway } from "./gateway.js";
import { createApp } from "./http/app.js";

const gw = createGateway(config);
const app = createApp(gw);
const server = app.listen(config.port, () => {
  const enabled = gw.backends.filter((b) => b.config.enabled).map((b) => `${b.config.id}(${b.config.model})`);
  console.log(`nalar-router on :${config.port} | backends: ${enabled.join(", ")} | KB ${gw.kb.entries.length} entries | demo=${config.demoMode}`);
});
// streaming responses can legitimately be long; don't let Node cut them
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 61_000;

const shutdown = () => {
  server.close(() => {
    gw.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
