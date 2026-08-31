// Runtime entrypoint: load config, connect to Postgres, serve.
import { loadDotEnv } from "./env.js";
import { loadConfig } from "./config.js";
import { createPool, isMemory } from "./db.js";
import { buildServer } from "./server.js";

loadDotEnv();

async function main() {
  const config = loadConfig();
  const pool = await createPool(config.databaseUrl);
  const app = buildServer({ pool, config });

  if (isMemory(config.databaseUrl)) {
    app.log.warn("Using in-memory database (pg-mem) — data is NOT persisted. Set DATABASE_URL for a real Postgres.");
  }
  if (config.usingDefaultToken) {
    const [[token, shopTag]] = config.tokenToShop;
    app.log.warn(`No INGEST_TOKENS set — using default dev token. In the extension set: shop tag "${shopTag}", token "${token}".`);
  }

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
