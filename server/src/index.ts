import { getConfig } from "./config.js";
import { log } from "./logger.js";
import { initDb } from "./db.js";
import { buildServer } from "./http/server.js";
import { attachWebSocket } from "./ws/hub.js";
import { closeAll } from "./agent/sessionManager.js";

async function main(): Promise<void> {
  const config = getConfig();
  initDb();

  const app = await buildServer();
  const wss = attachWebSocket(app.server);

  await app.listen({ host: config.bindAddress, port: config.port });

  log.info(`Bridge listening on http://${config.bindAddress}:${config.port}`);
  if (config.bindAddress === "0.0.0.0") {
    log.warn(
      "BIND_ADDRESS is 0.0.0.0 — the server is reachable on ALL interfaces. " +
        "Bind to the Tailscale IP/hostname and firewall the port on public interfaces.",
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down…`);
    try {
      await closeAll();
      wss.close();
      await app.close();
    } catch (err) {
      log.error("Error during shutdown:", err);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("Fatal startup error:", err);
  process.exit(1);
});
