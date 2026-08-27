// Runtime entrypoint: load config, connect to Postgres, serve.
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { buildServer } from "./server.js";

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const app = buildServer({ pool, config });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`shops configured: ${config.tokenToShop.size}`);
}

main().catch((err) => {
  console.error("[api] fatal:", err);
  process.exit(1);
});
