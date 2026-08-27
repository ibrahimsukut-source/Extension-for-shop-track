// Parse job entrypoint: drains unparsed raw_captures into the normalized tables
// and derives snapshot-diff events. Run on a schedule (cron / BullMQ, spec §8):
//   npm run parse
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { parseAll } from "./parse/runner.js";

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
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
