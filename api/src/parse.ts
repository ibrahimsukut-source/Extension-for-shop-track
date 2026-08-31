// Parse job entrypoint: drains unparsed raw_captures into the normalized tables
// and derives snapshot-diff events. Run on a schedule (cron / BullMQ, spec §8):
//   npm run parse
import { loadDotEnv } from "./env.js";
import { loadConfig } from "./config.js";
import { createPool, isMemory } from "./db.js";
import { parseAll } from "./parse/runner.js";

loadDotEnv();

async function main() {
  const config = loadConfig();
  if (isMemory(config.databaseUrl)) {
    console.log("[parse] in-memory mode has no persistent data to parse; nothing to do. (AUTO_PARSE handles the live demo.)");
    return;
  }
  const pool = await createPool(config.databaseUrl);
  try {
    const summary = await parseAll(pool);
    console.log("[parse] done:", JSON.stringify(summary));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[parse] failed:", err);
  process.exit(1);
});
