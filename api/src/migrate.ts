// Apply the reference schema (db/schema.sql) to the configured database.
// Idempotent: schema.sql uses CREATE TABLE/INDEX IF NOT EXISTS.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadDotEnv } from "./env.js";
import { loadConfig } from "./config.js";
import { createPool, isMemory } from "./db.js";

loadDotEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, "../../db/schema.sql");

async function main() {
  const config = loadConfig();
  if (isMemory(config.databaseUrl)) {
    console.log("[migrate] in-memory mode — schema is applied automatically at startup, nothing to migrate.");
    return;
  }
  const sql = await readFile(schemaPath, "utf8");
  const pool = await createPool(config.databaseUrl);
  try {
    await pool.query(sql);
    console.log(`[migrate] applied ${path.relative(process.cwd(), schemaPath)}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
